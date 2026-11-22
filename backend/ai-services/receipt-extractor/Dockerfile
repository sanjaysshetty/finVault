# Build context is backend/ (see template.yaml's Metadata.DockerContext)
# so this can reach both this function's own source and the shared
# finvault_agent_core layer's source tree in one build.
FROM public.ecr.aws/lambda/python:3.11

# Shared finvault_agent_core package + its own base dependencies
# (anthropic, mcp) -- copied directly since Layers aren't usable with
# container images at all. Rebuild this function if that shared source
# changes -- there's no "deploy once, every function picks it up" the
# way a Layer version bump worked.
COPY layers/finvault-agent-core/finvault_agent_core ${LAMBDA_TASK_ROOT}/finvault_agent_core
COPY layers/finvault-agent-core/requirements.txt /tmp/base-requirements.txt
RUN pip install --no-cache-dir -r /tmp/base-requirements.txt --target "${LAMBDA_TASK_ROOT}"

# This function has no extra dependencies of its own today -- this step
# is a no-op (the file is comments only) but kept for structural
# consistency with the other containerized functions, so a future
# dependency addition here doesn't need a new Dockerfile pattern.
COPY ai-services/receipt-extractor/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt --target "${LAMBDA_TASK_ROOT}"

# This function's own code
COPY ai-services/receipt-extractor/*.py ${LAMBDA_TASK_ROOT}/
COPY ai-services/receipt-extractor/prompts ${LAMBDA_TASK_ROOT}/prompts

CMD ["app.handler"]
