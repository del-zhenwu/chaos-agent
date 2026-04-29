# Chaos Mesh Experiment Results

**Experiment:** {SCENARIO_NAME}
**Target Namespace:** {NAMESPACE}
**Target Labels:** {LABEL_SELECTOR}

## Timeline

- **Start Time:** {START_TIME}
- **End Time:** {END_TIME}
- **Duration:** {DURATION}

## Pre-Experiment Health

- Pods found: {POD_COUNT}
- All pods healthy: {YES/NO}

## Post-Experiment Health

- Pods found: {POD_COUNT}
- All pods recovered: {YES/NO}

## Observations

- Describe what happened during the experiment.
- Did the pods crash? Did they restart?
- Did the network delay affect the application?
- Did the CPU/Memory stress cause OOMKills or throttling?

## Conclusion

- Was the system resilient to the injected fault?
- Are there any recommendations for improvement?
