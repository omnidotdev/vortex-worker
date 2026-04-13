import { beforeAll } from "bun:test";

beforeAll(() => {
  process.env.NODE_ENV = "test";
});
