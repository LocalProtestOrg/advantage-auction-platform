Review the current task status and determine the next required action.

Rules:
- If task is raw, send to PM
- If PM grooming is complete, send to SWE
- If implementation is complete, send to QA
- If QA passed, send to PM for final acceptance
- If QA failed, return to SWE with QA findings
- If PM accepted, mark task done

Output:
- Current status
- Missing artifacts
- Next role
- Exact next action