import type { CategoryAgent, Grounding } from './types';

export const complaintAgent: CategoryAgent = {
  category: 'complaint',
  displayName: 'Complaints',
  description: 'Empathetic resolution; no commercial objective',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'The customer is dissatisfied. Lead with genuine empathy and apologise for the trouble in the first sentence. Acknowledge the specific issue, explain the next step to put it right (or that you are escalating to the team), and reassure them. Do NOT upsell, suggest a purchase, or add any commercial nudge; resolution and care only. Never admit legal liability or promise a specific refund amount unless the facts provide one. Example: "I am so sorry your order arrived damaged, that is not the experience we want for you. I am escalating this to our team now and we will get it put right."';
  },
  deterministicAppendix(): string | null { return null; }
};
