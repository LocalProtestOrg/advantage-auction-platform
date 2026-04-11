# Development Process

## Required Workflow
Every task must follow this sequence:
1. Orchestrator creates or selects task
2. PM grooms the task
3. SWE implements the task
4. QA verifies the task
5. PM performs final acceptance review
6. Orchestrator marks complete only after PM acceptance

## Rules
- SWE may not skip PM grooming
- QA may not be skipped
- PM must compare final result to user story, business rules, and integration rules
- Orchestrator must send rejected QA tasks back to SWE
- Orchestrator must maintain backlog order unless priorities are changed explicitly

## Task States
- todo
- groomed
- in-progress
- qa-review
- pm-acceptance
- done
- blocked

## Definition of Done
A task is done only if:
- spec exists
- acceptance criteria are written
- implementation exists
- tests exist where applicable
- QA evidence is attached
- PM confirms the result matches the intended user experience and business rules