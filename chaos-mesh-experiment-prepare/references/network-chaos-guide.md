# NetworkChaos Guide

NetworkChaos allows you to simulate network faults.

**Kind:** `NetworkChaos`

**Actions:**
- `delay`: Inject network delay.
- `loss`: Inject packet loss.
- `duplicate`: Duplicate packets.
- `corrupt`: Corrupt packets.
- `partition`: Create network partitions.
- `bandwidth`: Limit network bandwidth.

**Additional Spec Fields:**

For `delay`:
```yaml
  delay:
    latency: '10ms'
    correlation: '100'
    jitter: '0ms'
```

For `loss`:
```yaml
  loss:
    loss: '50'
    correlation: '100'
```

**Example:**
```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: network-delay-example
  namespace: default
spec:
  action: delay
  mode: all
  selector:
    labelSelectors:
      'app': 'nginx'
  delay:
    latency: '10ms'
    correlation: '100'
    jitter: '0ms'
  duration: '10m'
```
