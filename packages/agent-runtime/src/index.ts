/**
 * @file Point d'entrée de `@midgaard/agent-runtime`.
 *
 * Le paquet ne dépend ni du daemon ni de la persistance : il reçoit un
 * adaptateur, un contexte d'outils et des crochets. C'est ce qui permet de
 * l'exercer avec un faux fournisseur — et donc de tester un dépassement de
 * budget sans dépenser un centime.
 */
export { runAgent } from './loop.ts'
export type {
  ApprovalOutcome,
  ApprovalRequest,
  LoopHooks,
  LoopInput,
  LoopOutcome,
  ToolCompletedInput,
  ToolRequestedInput,
} from './loop.ts'
export { budgetIsEnforceable, checkLimits, formatUsd } from './budget.ts'
export type { BudgetState, StopReason } from './budget.ts'
export { buildMessages, workspaceTree } from './context.ts'
export type { ContextInput } from './context.ts'
