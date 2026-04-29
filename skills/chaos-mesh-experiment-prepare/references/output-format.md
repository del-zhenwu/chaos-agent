# Output Format

Use this template for `README.md` in the generated output directory.

```markdown
# Chaos Mesh Experiment: {SCENARIO_NAME}

**Directory:** {ABSOLUTE_PATH_TO_DIR}
**Target Namespace:** {NAMESPACE}
**Target Labels:** {LABELS}
**Estimated Duration:** {DURATION}

## Affected Resources

| Resource Type | Count |
|---|---|
| Pods | {POD_COUNT} |

## Steps to Execute

1. Review `chaos-experiment.yaml`.
2. Run the `chaos-mesh-experiment-execute` skill to start the experiment.

## Cleanup

The experiment will automatically stop after `{DURATION}`. To manually stop it early, run:

```bash
kubectl delete -f chaos-experiment.yaml
```
```
