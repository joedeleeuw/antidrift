declare function authorize(action: string): void;

export function loadProject(req: { params: { projectId: string } }) {
  function inner() {
    return req.params.projectId;
  }

  authorize("project:read");
  return inner();
}
