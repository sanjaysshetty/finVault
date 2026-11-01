# Build context is backend/ (see template.yaml's Metadata.DockerContext)
# so this can reach both this function's own source and the shared
# finvault_agent_core layer's source tree in one build.
FROM public.ecr.aws/lambda/python:3.11

# Shared finvault_agent_core package + its own base dependencies
# (anthropic, mcp) -- same source this function used via a Lambda Layer
# before container packaging; copied directly since Layers aren't usable
# with container images at all. Rebuild this function if that shared
# source changes -- there's no "deploy once, every function picks it up"
# the way a Layer version bump worked.
COPY layers/finvault-agent-core/finvault_agent_core ${LAMBDA_TASK_ROOT}/finvault_agent_core
COPY layers/finvault-agent-core/requirements.txt /tmp/base-requirements.txt
RUN pip install --no-cache-dir -r /tmp/base-requirements.txt --target "${LAMBDA_TASK_ROOT}"

# This function's own extra dependencies -- yfinance (+curl_cffi, pandas,
# numpy) for get_option_chain, now in-process again; container images
# lift the 10GB ceiling well above this stack's ~174MB, so the
# standalone OptionsDataFunction split that zip packaging required is no
# longer needed (see get_option_chain's docstring in tower2_shared.py).
COPY ai-services/deep-dive/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt --target "${LAMBDA_TASK_ROOT}"

# This function's own code
COPY ai-services/deep-dive/*.py ${LAMBDA_TASK_ROOT}/
COPY ai-services/deep-dive/prompts ${LAMBDA_TASK_ROOT}/prompts

CMD ["handler.worker_handler"]
