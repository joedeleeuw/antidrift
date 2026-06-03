declare function authorize(action: string): void;

export function loadProject(req: { params: { projectId: string } }) {
  authorize("project:read");
  return req.params.projectId;
}
