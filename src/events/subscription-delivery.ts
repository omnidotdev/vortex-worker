/**
 * Subscription delivery engine.
 *
 * Delivers events to webhook subscribers via HMAC-signed HTTP POSTs.
 * Handles retries with exponential backoff and moves to DLQ on exhaustion.
 */

import { getDb } from "db";
import { eventSubscriptionTable, subscriptionDeliveryTable } from "db/schema";
import { and, eq, lte } from "drizzle-orm";
import jsonata from "jsonata";

import logger from "lib/logger";

import type { EventSubscription } from "db/schema";
import type { OmniEvent } from "./types";

/**
 * Sign a payload string with HMAC-SHA256.
 */
const signPayload = async (
  secret: string,
  payload: string,
): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Calculate the next retry time using exponential backoff.
 */
const calculateBackoff = (
  attempts: number,
  initialMs: number,
  multiplier: number,
): Date => {
  const delayMs = initialMs * multiplier ** attempts;
  return new Date(Date.now() + delayMs);
};

/**
 * Build the delivery payload based on subscription configuration.
 */
const buildPayload = async (
  event: OmniEvent,
  subscription: EventSubscription,
): Promise<unknown> => {
  let payload: unknown;

  if (subscription.payloadMode === "envelope") {
    payload = {
      specversion: "1.0",
      id: event.id,
      type: event.type,
      source: event.source,
      subject: event.subject,
      time: event.timestamp,
      data: event.data,
      organizationid: event.organizationId,
      correlationid: event.correlationId,
    };
  } else {
    payload = event.data;
  }

  // Apply JSONata transform if configured
  if (subscription.transform) {
    const expression = jsonata(subscription.transform);
    payload = await expression.evaluate(payload);
  }

  return payload;
};

/**
 * Deliver a single event to a single subscription endpoint.
 */
const deliverToSubscription = async (
  event: OmniEvent,
  subscription: EventSubscription,
): Promise<void> => {
  const db = getDb();
  const deliveryId = crypto.randomUUID();

  // Build payload before delivery attempt so it's available for storage on failure
  let deliveryPayload: unknown;
  let payloadStr: string | undefined;
  try {
    deliveryPayload = await buildPayload(event, subscription);
    payloadStr = JSON.stringify(deliveryPayload);
  } catch (buildErr) {
    logger.warn("Failed to build delivery payload", {
      subscriptionId: subscription.id,
      eventType: event.type,
      error: buildErr instanceof Error ? buildErr.message : String(buildErr),
    });
  }

  try {
    if (!payloadStr) throw new Error("Failed to build delivery payload");
    const hex = await signPayload(subscription.hmacSecret, payloadStr);

    const response = await fetch(subscription.targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [subscription.signatureHeader]: hex,
        "X-Vortex-Event-Type": event.type,
        "X-Vortex-Delivery-Id": deliveryId,
      },
      body: payloadStr,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      await db.insert(subscriptionDeliveryTable).values({
        subscriptionId: subscription.id,
        eventId: event.id,
        eventType: event.type,
        organizationId: event.organizationId,
        payload: deliveryPayload,
        status: "delivered",
        attempts: 1,
        httpStatus: response.status,
        completedAt: new Date().toISOString(),
      });

      logger.info("Subscription delivery succeeded", {
        deliveryId,
        subscriptionId: subscription.id,
        eventType: event.type,
        httpStatus: response.status,
      });
    } else {
      throw new DeliveryError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
      );
    }
  } catch (err) {
    const httpStatus =
      err instanceof DeliveryError ? err.httpStatus : undefined;
    const errorMsg =
      err instanceof Error
        ? err.message.slice(0, 500)
        : String(err).slice(0, 500);

    // First attempt failed — schedule retry or DLQ
    if (subscription.maxRetries > 0) {
      await db.insert(subscriptionDeliveryTable).values({
        subscriptionId: subscription.id,
        eventId: event.id,
        eventType: event.type,
        organizationId: event.organizationId,
        payload: deliveryPayload,
        status: "pending",
        attempts: 1,
        httpStatus,
        error: errorMsg,
        nextRetryAt: calculateBackoff(
          0,
          subscription.initialBackoffMs,
          subscription.backoffMultiplier,
        ).toISOString(),
      });
    } else {
      await db.insert(subscriptionDeliveryTable).values({
        subscriptionId: subscription.id,
        eventId: event.id,
        eventType: event.type,
        organizationId: event.organizationId,
        payload: deliveryPayload,
        status: "dlq",
        attempts: 1,
        httpStatus,
        error: errorMsg,
        completedAt: new Date().toISOString(),
      });
    }

    logger.warn("Subscription delivery failed, scheduled retry", {
      deliveryId,
      subscriptionId: subscription.id,
      eventType: event.type,
      error: errorMsg,
    });
  }
};

/**
 * Deliver an event to all matching subscriptions.
 * Fire-and-forget per subscription — failures are handled individually.
 */
const deliverToSubscriptions = async (
  event: OmniEvent,
  subscriptions: EventSubscription[],
): Promise<void> => {
  await Promise.allSettled(
    subscriptions.map((sub) => deliverToSubscription(event, sub)),
  );
};

/**
 * Retry poller — processes pending deliveries whose retry time has arrived.
 * Runs on a 5-second interval alongside the event consumer.
 */
const startRetryPoller = (): ReturnType<typeof setInterval> => {
  return setInterval(async () => {
    try {
      const db = getDb();

      const pendingDeliveries = await db
        .select()
        .from(subscriptionDeliveryTable)
        .where(
          and(
            eq(subscriptionDeliveryTable.status, "pending"),
            lte(
              subscriptionDeliveryTable.nextRetryAt,
              new Date().toISOString(),
            ),
          ),
        )
        .limit(50);

      for (const delivery of pendingDeliveries) {
        try {
          // Look up subscription for config
          const [subscription] = await db
            .select()
            .from(eventSubscriptionTable)
            .where(eq(eventSubscriptionTable.id, delivery.subscriptionId))
            .limit(1);

          if (!subscription || !subscription.enabled) {
            // Subscription deleted or disabled — mark as failed
            await db
              .update(subscriptionDeliveryTable)
              .set({
                status: "failed",
                error: "Subscription disabled or deleted",
                completedAt: new Date().toISOString(),
              })
              .where(eq(subscriptionDeliveryTable.id, delivery.id));
            continue;
          }

          // Re-attempt delivery with stored payload (fallback for pre-migration rows)
          const payloadStr = delivery.payload
            ? JSON.stringify(delivery.payload)
            : JSON.stringify({ eventId: delivery.eventId, eventType: delivery.eventType });
          const hex = await signPayload(subscription.hmacSecret, payloadStr);

          const response = await fetch(subscription.targetUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [subscription.signatureHeader]: hex,
              "X-Vortex-Event-Type": delivery.eventType,
              "X-Vortex-Delivery-Id": `retry-${delivery.id}`,
            },
            body: payloadStr,
            signal: AbortSignal.timeout(10000),
          });

          if (response.ok) {
            await db
              .update(subscriptionDeliveryTable)
              .set({
                status: "delivered",
                attempts: delivery.attempts + 1,
                httpStatus: response.status,
                completedAt: new Date().toISOString(),
                error: null,
                nextRetryAt: null,
              })
              .where(eq(subscriptionDeliveryTable.id, delivery.id));

            logger.info("Subscription delivery retry succeeded", {
              deliveryId: delivery.id,
              subscriptionId: subscription.id,
              attempt: delivery.attempts + 1,
            });
          } else {
            throw new DeliveryError(
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
            );
          }
        } catch (err) {
          const nextAttempt = delivery.attempts + 1;
          const errorMsg =
            err instanceof Error
              ? err.message.slice(0, 500)
              : String(err).slice(0, 500);

          // Look up max retries from subscription
          const [sub] = await db
            .select({
              maxRetries: eventSubscriptionTable.maxRetries,
              initialBackoffMs: eventSubscriptionTable.initialBackoffMs,
              backoffMultiplier: eventSubscriptionTable.backoffMultiplier,
            })
            .from(eventSubscriptionTable)
            .where(eq(eventSubscriptionTable.id, delivery.subscriptionId))
            .limit(1);

          const maxRetries = sub?.maxRetries ?? 5;

          if (nextAttempt >= maxRetries) {
            // Exhausted retries — move to DLQ
            await db
              .update(subscriptionDeliveryTable)
              .set({
                status: "dlq",
                attempts: nextAttempt,
                error: errorMsg,
                completedAt: new Date().toISOString(),
                nextRetryAt: null,
              })
              .where(eq(subscriptionDeliveryTable.id, delivery.id));

            logger.error("Subscription delivery exhausted retries", {
              deliveryId: delivery.id,
              subscriptionId: delivery.subscriptionId,
              attempts: nextAttempt,
            });
          } else {
            // Schedule next retry
            const backoff = calculateBackoff(
              nextAttempt,
              sub?.initialBackoffMs ?? 1000,
              sub?.backoffMultiplier ?? 2,
            );

            await db
              .update(subscriptionDeliveryTable)
              .set({
                attempts: nextAttempt,
                error: errorMsg,
                httpStatus:
                  err instanceof DeliveryError ? err.httpStatus : null,
                nextRetryAt: backoff.toISOString(),
              })
              .where(eq(subscriptionDeliveryTable.id, delivery.id));
          }
        }
      }
    } catch (err) {
      logger.error("Subscription retry poller error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 5000);
};

/**
 * Typed error for HTTP delivery failures with status code.
 */
class DeliveryError extends Error {
  httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "DeliveryError";
    this.httpStatus = httpStatus;
  }
}

export { deliverToSubscriptions, startRetryPoller };
