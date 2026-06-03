export function loadProject(req: { params: { projectId: string } }) {
  return req.params.projectId;
}
