import { analysisPrompt } from './analysis/claude.provider';
import { reportPrompt } from './report/rapporteur-report';

const context = {
  event: 'Build 2026',
  session: 'What Africa Stands to Lose',
  speakers: ['Prof. Victor Odumuyiwa (University of Lagos)'],
  targets: [],
  alreadyRecorded: [],
};
const line = [
  { n: 1, at: new Date('2026-10-22T09:20:00Z'), who: 'Mic 1', text: 'Hello.' },
];

describe('session briefs in the AI prompts', () => {
  it('gives the analysis the brief, after the session and before the transcript', () => {
    const prompt = analysisPrompt(line, {
      ...context,
      brief: '1. The economic costs.\n2. The cost of delay.',
    });
    expect(prompt).toContain(
      'SESSION BRIEF:\n1. The economic costs.\n2. The cost of delay.',
    );
    expect(prompt.indexOf('SESSION:')).toBeLessThan(
      prompt.indexOf('SESSION BRIEF:'),
    );
    expect(prompt.indexOf('SESSION BRIEF:')).toBeLessThan(
      prompt.indexOf('TRANSCRIPT:'),
    );
  });

  it('leaves the brief out when there is none', () => {
    expect(analysisPrompt(line, context)).not.toContain('SESSION BRIEF');
    expect(analysisPrompt(line, { ...context, brief: '   ' })).not.toContain(
      'SESSION BRIEF',
    );
  });

  it('gives the rapporteur the brief', () => {
    const brief = {
      event: 'Build 2026',
      session: 'What Africa Stands to Lose',
      description: null,
      speakers: [],
      calls: [],
    };
    expect(
      reportPrompt(
        { ...brief, sessionBrief: 'Purpose: make the hidden costs visible.' },
        'transcript',
      ),
    ).toContain(
      'Session brief (what the organisers asked the session to address):\nPurpose: make the hidden costs visible.',
    );
    expect(reportPrompt(brief, 'transcript')).not.toContain('Session brief');
  });
});
