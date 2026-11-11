
export type DomainType =
  | 'medical_health'
  | 'non_medical_health'
  | 'mixed';

export type SegmentDomain =
  | 'medical_health'
  | 'non_medical_health';

export type SegmentDecision =
  | 'continue_to_p2'
  | 'refuse';

export type MedicalRiskLevel =
  | 'emergency'
  | 'needs_attention'
  | 'routine';

export type RiskAssessmentStatus =
  | 'assessed'
  | 'insufficient_information'
  | 'not_applicable';

export type RecommendedAction =
  | 'emergency_response'
  | 'seek_medical_attention'
  | 'continue_to_p2'
  | 'continue_with_clarification'
  | 'not_applicable';

export interface P1Segment {
  segment_id: string;
  content: string;
  domain: SegmentDomain;
  decision: SegmentDecision;
}

export interface P1MedicalRisk {
  applicable: boolean;
  level: MedicalRiskLevel | null;
  assessment_status: RiskAssessmentStatus;
  risk_signals: string[];
  missing_information: string[];
  recommended_action: RecommendedAction;
}

export interface P1Routing {
  continue_to_p2: boolean;
  p2_segment_ids: string[];
  refused_segment_ids: string[];
  urgent_response_required: boolean;
  stop_normal_flow: boolean;
  safety_notice_required: boolean;
}

export interface P1Result {
  stage: 'P1';
  domain_type: DomainType;
  segments: P1Segment[];
  medical_risk: P1MedicalRisk;
  routing: P1Routing;
}
