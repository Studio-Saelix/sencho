export interface ComposeDiscovery {
  composeDir: string;
  stackCount: number;
  adoptCandidateCount: number;
  adoptCandidatesTruncated: boolean;
}

export interface StacksDiscoveryResponse {
  composeDir: string;
  readable: boolean;
  discovery: ComposeDiscovery | null;
  error?: string;
}
