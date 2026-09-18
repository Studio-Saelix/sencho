/** How a managed input's on-disk bytes are encrypted. */
export type InputEncryptionKind = 'none' | 'sops-age' | 'sops-unsupported';

export type EncryptedSourcePolicy = 'allow_plaintext' | 'require_encrypted';

export type SopsFailureClass =
  | 'missing_key'
  | 'wrong_identity'
  | 'invalid_ciphertext'
  | 'unsupported_backend'
  | 'authorization'
  | 'capability_mismatch'
  | 'decrypt_failed'
  | 'cleanup_failed';

export type SecretCapabilityInput = {
  role: string;
  encryption: InputEncryptionKind;
  recipientIds: string[];
  sourcePath: string | null;
  /** Stack-relative ciphertext path at this generation. Recovery overlay fails closed when this is missing. */
  materializedPath: string | null;
};

/** Redacted capability metadata stored on generations; never contains secret values. */
export type SecretCapability = {
  policy: EncryptedSourcePolicy;
  inputs: SecretCapabilityInput[];
  ready: boolean;
  failureClass?: SopsFailureClass;
  requiredRecipients: string[];
};

export type OverlayBinding = {
  applicationId: string;
  commitSha: string;
  generationId: string;
  operationId: string;
  stackName: string;
  nodeId: number;
};

export type PublicSopsIdentity = {
  id: string;
  recipient: string;
  label: string | null;
  createdAt: number;
  rotatedAt: number | null;
};

export type SopsIdentityReadiness = {
  identities: PublicSopsIdentity[];
  requiredRecipients: string[];
  ready: boolean;
  failureClass?: SopsFailureClass;
  policy: EncryptedSourcePolicy;
};

export type SopsIdentityImpact = {
  generationId: string;
  commitSha: string;
  status: string;
  requiredRecipients: string[];
};
