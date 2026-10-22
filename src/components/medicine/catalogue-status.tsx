import { Badge } from '~/components/ui/badge';
import {
  CLINICAL_SECTION_STATUS_LABEL,
  REGISTRATION_STATUS_LABEL,
  SUBMISSION_STATUS_LABEL,
  VERIFICATION_STATUS_LABEL,
} from '~/domain/medicine-catalogue';
import type {
  ClinicalSectionStatus,
  MedicineRegistrationStatus,
  MedicineSubmissionStatus,
  MedicineVerificationStatus,
} from '~/lib/db.types';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'outline';

const VERIFICATION_VARIANT: Record<MedicineVerificationStatus, BadgeVariant> = {
  draft: 'neutral',
  pending_review: 'warning',
  verified: 'success',
  rejected: 'danger',
  outdated: 'warning',
};

const REGISTRATION_VARIANT: Record<MedicineRegistrationStatus, BadgeVariant> = {
  unverified: 'neutral',
  pending: 'warning',
  verified: 'success',
  mismatch: 'danger',
  not_applicable: 'outline',
};

const SECTION_VARIANT: Record<ClinicalSectionStatus, BadgeVariant> = {
  not_established: 'outline',
  not_verified: 'warning',
  verified: 'success',
  not_applicable: 'outline',
};

const SUBMISSION_VARIANT: Record<MedicineSubmissionStatus, BadgeVariant> = {
  draft: 'neutral',
  submitted: 'info',
  under_review: 'warning',
  accepted: 'success',
  rejected: 'danger',
  withdrawn: 'outline',
};

export function VerificationBadge({
  status,
  className,
}: {
  status: MedicineVerificationStatus;
  className?: string;
}) {
  return (
    <Badge variant={VERIFICATION_VARIANT[status] ?? 'neutral'} className={className}>
      {VERIFICATION_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function RegistrationBadge({
  status,
  className,
}: {
  status: MedicineRegistrationStatus;
  className?: string;
}) {
  return (
    <Badge variant={REGISTRATION_VARIANT[status] ?? 'neutral'} className={className}>
      {REGISTRATION_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function SectionStatusBadge({ status }: { status: ClinicalSectionStatus }) {
  return (
    <Badge variant={SECTION_VARIANT[status] ?? 'neutral'}>
      {CLINICAL_SECTION_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function SubmissionStatusBadge({ status }: { status: MedicineSubmissionStatus }) {
  return (
    <Badge variant={SUBMISSION_VARIANT[status] ?? 'neutral'}>
      {SUBMISSION_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
