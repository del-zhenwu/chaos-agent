# PodChaos Guide

PodChaos allows you to simulate pod faults.

**Kind:** `PodChaos`

**Actions:**
- `pod-kill`: Kill a pod.
- `pod-failure`: Make a pod unavailable.
- `container-kill`: Kill a specific container.

**Additional Spec Fields:**
- For `container-kill`, you must specify the `containerNames` list:
  ```yaml
  containerNames:
    - "my-container"
  ```

**Example:**
```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-kill-example
  namespace: default
spec:
  action: pod-kill
  mode: one
  duration: '5m'
  selector:
    labelSelectors:
      'app': 'nginx'
```
