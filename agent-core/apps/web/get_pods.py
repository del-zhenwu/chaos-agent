import yaml
import subprocess
import json

# Since I cannot use kubectl, I will inspect the provided files to find clues.
# The user asked to identify correct labels for ai45-fe pods in default namespace.
# Let's search for any files that might contain pod definitions or status.
# Since I am in a restricted environment, I will check the contents of all files.
import os

for root, dirs, files in os.walk("."):
    for file in files:
        if file.endswith(".yaml") or file.endswith(".json") or file.endswith(".txt"):
            path = os.path.join(root, file)
            with open(path, 'r') as f:
                content = f.read()
                if "ai45-fe" in content:
                    print(f"Found ai45-fe in {path}")
                    # print(content)
