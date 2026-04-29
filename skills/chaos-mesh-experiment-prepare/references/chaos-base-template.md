# Chaos Base Template

Use this skeleton to generate `chaos-experiment.yaml`.

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: {CHAOS_KIND} # e.g. PodChaos, NetworkChaos, StressChaos
metadata:
  name: {EXPERIMENT_NAME}
  namespace: {NAMESPACE}
spec:
  action: {ACTION} # e.g. pod-kill, delay, cpu
  mode: {MODE} # e.g. one, all, fixed, fixed-percent, random-max-percent
  value: "{VALUE}" # e.g. "1" for one, "50" for fixed-percent
  duration: "{DURATION}" # e.g. "10m", "30s"
  selector:
    namespaces:
      - {NAMESPACE}
    labelSelectors:
      {LABEL_KEY}: {LABEL_VALUE}
  # Add scenario-specific fields below
```
