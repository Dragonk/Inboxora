import re

with open('backend/src/services/calendarProjectionPool.ts', 'r') as f:
    content = f.read()

# Fix the tsx loader missing in vitest
content = content.replace("filtered.includes('--import=tsx');", "filtered.includes('--import=tsx');\\n  if (SOURCE_WORKER && !hasTsx) filtered.push('--import', 'tsx');")

with open('backend/src/services/calendarProjectionPool.ts', 'w') as f:
    f.write(content)
