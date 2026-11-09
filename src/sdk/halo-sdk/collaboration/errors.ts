/** A known refusal before the requested operation changes state. */
export class CollaborationRefusal extends Error {
  constructor(readonly code: string, message: string, scope?: { teamId: string; epochId: string; taskId?: string }) {
    super(message);
    this.name = 'CollaborationRefusal';
    console.warn(`[Collaboration] Operation refused: code=${code}${scope ? ` team=${scope.teamId} epoch=${scope.epochId} task=${scope.taskId ?? '-'}` : ''}`);
  }
}
