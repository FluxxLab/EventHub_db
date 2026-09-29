import { SetMetadata } from '@nestjs/common';
import { EventSeverity } from '../../security/entities/security-event.entity';

export const AUDIT_KEY = 'audit';

export interface AuditMeta {
  type: string;
  description: string;
  severity?: EventSeverity;
}

export const Audit = (meta: AuditMeta) => SetMetadata(AUDIT_KEY, meta);
