export interface MessagingMember {
  appId: string;
  memberName: string;
  origin?: 'local' | 'remote';
  ownerNodeId?: string;
}

/** The authoritative membership/relationship view supplied by a host. */
export interface MessageBusStore {
  getMember(teamId: string, memberId: string, epochId?: string): MessagingMember | null;
  getMemberByName(teamId: string, name: string, epochId?: string): MessagingMember | null;
  listMembersByTeam(teamId: string, epochId?: string): MessagingMember[];
  isEdgeAllowed(teamId: string, from: string, to: string, epochId?: string): boolean;
  /** Supplies the reserved lead address independently of the member's display name. */
  getTeamById(teamId: string): { leadAppId?: string | null } | null;
  getEpochById(epochId: string): { endedAt: number | null } | null;
}
