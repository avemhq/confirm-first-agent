/**
 * Server-defined identifiers that may appear in audit rows without a project.
 * Such rows stay visible after access to a project is revoked, so they must never carry text
 * the model chose (an unknown tool name or argument name can smuggle project content).
 * test/audit.test.ts checks that these lists match the tool registry exactly.
 */
export const TOOL_NAMES = [
  'list_projects',
  'search_tasks',
  'get_task',
  'search_documents',
  'get_document',
  'project_report_data',
  'propose_create_task',
  'propose_update_task_status',
  'propose_assign_task',
  'propose_save_report',
] as const

export const FIELD_NAMES = [
  'assigneeId',
  'body',
  'description',
  'documentId',
  'dueDate',
  'limit',
  'overdueOnly',
  'projectId',
  'query',
  'reason',
  'status',
  'taskId',
  'title',
] as const

const toolSet: ReadonlySet<string> = new Set(TOOL_NAMES)
const fieldSet: ReadonlySet<string> = new Set(FIELD_NAMES)

export const isKnownTool = (name: unknown): name is string => typeof name === 'string' && toolSet.has(name)
export const isKnownField = (name: unknown): name is string => typeof name === 'string' && fieldSet.has(name)
