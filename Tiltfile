v1alpha1.extension_repo(name='omni', url='https://github.com/omnidotdev/tilt-extensions')
v1alpha1.extension(name='dotenv_values', repo_name='omni', repo_path='dotenv_values')
load('ext://dotenv_values', 'dotenv_values')

env_local = dotenv_values(".env.local")
project_name = "vortex-worker"

local_resource(
    "install-deps-%s" % project_name,
    cmd="bun i",
    deps=["package.json"],
    labels=[project_name],
)

local_resource(
    "dev-%s" % project_name,
    serve_cmd="bun dev",
    labels=[project_name],
    env=env_local,
    resource_deps=["hatchet"],
)

docker_compose('compose.yaml')

# Hatchet dashboard at http://localhost:8888
dc_resource('hatchet', labels=['workflow-engine'])
dc_resource('hatchet-db', labels=['workflow-engine'])

# Temporal (optional) - uncomment to use instead of Hatchet
# UI at http://localhost:8233
# dc_resource('temporal', labels=['workflow-engine'])
# dc_resource('temporal-db', labels=['workflow-engine'])
