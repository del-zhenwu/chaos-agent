# StressChaos Guide

StressChaos allows you to simulate CPU and Memory stress.

**Kind:** `StressChaos`

**Actions:**
- `cpu`: Stress CPU.
- `memory`: Stress Memory.

**Additional Spec Fields:**

For `cpu`:
```yaml
  stressors:
    cpu:
      workers: 1
      load: 100
```

For `memory`:
```yaml
  stressors:
    memory:
      workers: 4
      size: '256MB'
```

**Example:**
```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: cpu-stress-example
  namespace: default
spec:
  mode: one
  selector:
    labelSelectors:
      'app': 'nginx'
  stressors:
    cpu:
      workers: 1
      load: 100
  duration: '5m'
```
