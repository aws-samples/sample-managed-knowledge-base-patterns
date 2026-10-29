"""Root pytest configuration.

The agent is a separate uv project with its own dependencies and tests, and
the Node.js packages contain no Python tests. Run them from their own
directories instead of collecting them here.
"""

collect_ignore = ["agent", "frontend", "infra/node_modules", "infra/cdk.out"]
