/**
 * Versioned project configuration (blueprint §7 "active-rule configuration",
 * §8.7). The controlling agreement's rules live here as DATA, never hardcoded
 * into client or engine logic. A configuration is immutable once activated;
 * changes require a new version with its own effectiveAt date.
 */

export type EvidenceType =
  | 'VIDEO'
  | 'WEIGHT'
  | 'EXTERNAL_LINK'
  | 'TRACKING'
  | 'PHOTO';

export type PublicationRule = 'PRIVATE' | 'PENDING' | 'PUBLIC' | 'UNLISTED' | 'WITHHELD';

export interface RequirementConfig {
  code: string;
  name: string;
  description: string;
  evidenceType: EvidenceType;
  /** "DAILY" or "WEEKLY:<0-6 luxon weekday>" (1=Mon..7=Sun). */
  schedule: string;
  /** Wall-clock deadline time in project zone, 24h "HH:MM". */
  deadlineTime: string;
  /** ISO-8601 duration grace, or null. */
  grace: string | null;
  mandatory: boolean;
  correctionAllowed: boolean;
  /** ISO-8601 duration correction window from deficiency issuance. */
  correctionWindow: string | null;
  publicationRule: PublicationRule;
  /** Optional external platform hint for EXTERNAL_LINK requirements. */
  platform?: string;
}

export interface RecordingStep {
  name: string;
  instruction: string;
  teleprompter: string;
  minHoldSeconds: number;
  maxRecommendedSeconds: number;
  speechRequired: boolean;
  pauseAllowed: boolean;
  skippable: boolean;
}

export interface ConsequenceRule {
  violationType: string;
  occurrence: number; // 1st, 2nd, ... occurrence
  amount: number | null; // financial amount, if any
  action: string | null; // non-financial action, if any
  dueInDays: number;
  escalates: boolean;
}

export interface ProjectConfiguration {
  identity: {
    projectName: string;
    participantDisplayName: string;
    publicDomain: string;
    timeZone: string; // IANA
  };
  measurements: {
    startWeight: number;
    goalWeight: number;
    unit: 'lb' | 'kg';
    precision: number;
    milestones: number[]; // milestone weights
    maintenancePeriodDays: number;
  };
  dates: {
    effectiveDate: string; // local date
    startDate: string; // local date, project day 1
  };
  requirements: RequirementConfig[];
  recordingTemplate: {
    name: string;
    scriptVersion: string;
    steps: RecordingStep[];
    requiredVariables: string[];
  };
  reviews: {
    weeklyWeekday: number; // 1=Mon..7=Sun (luxon)
    deadlineTime: string;
    publicationRule: PublicationRule;
  };
  consequences: ConsequenceRule[];
  /** Publication defaults per record kind. */
  publication: {
    projectDaysDefault: PublicationRule;
    weightsDefault: PublicationRule;
    violationsDefault: PublicationRule;
  };
}

/**
 * SEED configuration (blueprint §28). Demonstration values only — every value
 * is editable through versioned administration and MUST be compared against
 * the controlling signed agreement and explicitly approved by the AP before
 * production activation. See docs/ASSUMPTIONS.md.
 */
export const SEED_CONFIGURATION: ProjectConfiguration = {
  identity: {
    projectName: 'Micheal Ray Berry Public Accountability Project',
    participantDisplayName: 'Micheal Ray Berry',
    publicDomain: 'michealrayberry.com',
    timeZone: 'America/New_York',
  },
  measurements: {
    startWeight: 285.0,
    goalWeight: 200.0,
    unit: 'lb',
    precision: 1,
    milestones: [270, 255, 240, 225, 210, 200],
    maintenancePeriodDays: 30,
  },
  dates: {
    effectiveDate: '2026-06-18',
    startDate: '2026-06-18',
  },
  requirements: [
    {
      code: 'DAILY_VIDEO',
      name: 'Daily inspection video',
      description: 'Guided multi-step daily documentation video.',
      evidenceType: 'VIDEO',
      schedule: 'DAILY',
      deadlineTime: '23:59',
      grace: null,
      mandatory: true,
      correctionAllowed: true,
      correctionWindow: 'PT24H',
      publicationRule: 'PENDING',
    },
    {
      code: 'DAILY_TRACKING',
      name: 'Daily tracking entry',
      description: 'Structured tracking entry including documented weight.',
      evidenceType: 'TRACKING',
      schedule: 'DAILY',
      deadlineTime: '23:59',
      grace: null,
      mandatory: true,
      correctionAllowed: true,
      correctionWindow: 'PT24H',
      publicationRule: 'PENDING',
    },
    {
      code: 'DAILY_WEIGHT',
      name: 'Weight entry',
      description: 'Documented daily weigh-in with scale photo.',
      evidenceType: 'WEIGHT',
      schedule: 'DAILY',
      deadlineTime: '23:59',
      grace: null,
      mandatory: true,
      correctionAllowed: true,
      correctionWindow: 'PT24H',
      publicationRule: 'PENDING',
    },
    {
      code: 'WEBSITE_UPDATE',
      name: 'Website update',
      description: 'Daily update published to the official website.',
      evidenceType: 'EXTERNAL_LINK',
      schedule: 'DAILY',
      deadlineTime: '23:59',
      grace: 'PT1H',
      mandatory: false,
      correctionAllowed: true,
      correctionWindow: 'PT24H',
      publicationRule: 'PUBLIC',
      platform: 'website',
    },
    {
      code: 'X_CHECKIN',
      name: 'X check-in',
      description: 'Daily public check-in post on X.',
      evidenceType: 'EXTERNAL_LINK',
      schedule: 'DAILY',
      deadlineTime: '23:59',
      grace: 'PT1H',
      mandatory: false,
      correctionAllowed: true,
      correctionWindow: 'PT24H',
      publicationRule: 'PUBLIC',
      platform: 'x',
    },
    {
      code: 'WEEKLY_PHOTOS',
      name: 'Weekly progress photographs',
      description: 'Weekly documentation photographs.',
      evidenceType: 'PHOTO',
      schedule: 'WEEKLY:7', // Sunday
      deadlineTime: '23:59',
      grace: null,
      mandatory: true,
      correctionAllowed: true,
      correctionWindow: 'PT48H',
      publicationRule: 'PENDING',
    },
  ],
  recordingTemplate: {
    name: 'Standard daily documentation',
    scriptVersion: '1.0.0',
    requiredVariables: ['participantName', 'fullDate', 'projectDay', 'currentWeight'],
    steps: [
      {
        name: 'Opening statement',
        instruction: 'State your name, the full date, and the project day.',
        teleprompter:
          'My name is {participantName}. Today is {fullDate}. This is project day {projectDay}.',
        minHoldSeconds: 5,
        maxRecommendedSeconds: 20,
        speechRequired: true,
        pauseAllowed: false,
        skippable: false,
      },
      {
        name: 'Weight statement',
        instruction: 'State your documented weight for today.',
        teleprompter: 'My documented weight today is {currentWeight} pounds.',
        minHoldSeconds: 4,
        maxRecommendedSeconds: 15,
        speechRequired: true,
        pauseAllowed: false,
        skippable: false,
      },
      {
        name: 'Front position',
        instruction: 'Face the camera directly.',
        teleprompter: '',
        minHoldSeconds: 5,
        maxRecommendedSeconds: 10,
        speechRequired: false,
        pauseAllowed: false,
        skippable: false,
      },
      {
        name: 'Left position',
        instruction: 'Turn to show your left side.',
        teleprompter: '',
        minHoldSeconds: 5,
        maxRecommendedSeconds: 10,
        speechRequired: false,
        pauseAllowed: false,
        skippable: false,
      },
      {
        name: 'Back position',
        instruction: 'Turn to face away from the camera.',
        teleprompter: '',
        minHoldSeconds: 5,
        maxRecommendedSeconds: 10,
        speechRequired: false,
        pauseAllowed: false,
        skippable: false,
      },
      {
        name: 'Right position',
        instruction: 'Turn to show your right side.',
        teleprompter: '',
        minHoldSeconds: 5,
        maxRecommendedSeconds: 10,
        speechRequired: false,
        pauseAllowed: false,
        skippable: false,
      },
      {
        name: 'Closing statement',
        instruction: 'Confirm the record is accurate.',
        teleprompter:
          'This record for project day {projectDay} is accurate to the best of my knowledge.',
        minHoldSeconds: 5,
        maxRecommendedSeconds: 20,
        speechRequired: true,
        pauseAllowed: false,
        skippable: false,
      },
    ],
  },
  reviews: {
    weeklyWeekday: 7, // Sunday
    deadlineTime: '23:59',
    publicationRule: 'PUBLIC',
  },
  consequences: [
    { violationType: 'MISSED_DAILY', occurrence: 1, amount: 25, action: null, dueInDays: 7, escalates: true },
    { violationType: 'MISSED_DAILY', occurrence: 2, amount: 50, action: null, dueInDays: 7, escalates: true },
    { violationType: 'MISSED_DAILY', occurrence: 3, amount: 100, action: null, dueInDays: 7, escalates: true },
    { violationType: 'MISSED_WEEKLY', occurrence: 1, amount: 50, action: null, dueInDays: 7, escalates: true },
  ],
  publication: {
    projectDaysDefault: 'PENDING',
    weightsDefault: 'PENDING',
    violationsDefault: 'PENDING',
  },
};
