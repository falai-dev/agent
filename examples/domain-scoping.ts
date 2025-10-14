/**
 * Domain Scoping Example
 *
 * This example demonstrates how to use domain scoping to restrict which tools
 * are available in different conversation routes for security and clarity.
 */

import { Agent, createMessageEvent, EventSource } from '../src/index';
import { GeminiProvider } from '../src/providers/GeminiProvider';

// Initialize AI provider
const ai = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY || 'your-api-key-here',
  model: 'gemini-2.0-flash-exp',
});

// Create agent
const agent = new Agent({
  name: 'Multi-Domain Assistant',
  description:
    'An assistant that handles different tasks with domain-scoped tools',
  ai,
});

// Register different domains with their tools
agent.addDomain('scraping', {
  scrapeSite: async (url: string) => {
    console.log(`[Scraping] Scraping site: ${url}`);
    return { success: true, data: 'Scraped content...' };
  },
  extractData: async (html: string, selector: string) => {
    console.log(`[Scraping] Extracting data with selector: ${selector}`);
    return { elements: [] };
  },
});

agent.addDomain('calendar', {
  scheduleEvent: async (date: Date, title: string, description?: string) => {
    console.log(`[Calendar] Scheduling event: ${title} on ${date}`);
    return { eventId: 'evt_123', success: true };
  },
  listEvents: async (startDate: Date, endDate: Date) => {
    console.log(`[Calendar] Listing events from ${startDate} to ${endDate}`);
    return { events: [] };
  },
  cancelEvent: async (eventId: string) => {
    console.log(`[Calendar] Cancelling event: ${eventId}`);
    return { success: true };
  },
});

agent.addDomain('payment', {
  processPayment: async (amount: number, currency: string) => {
    console.log(`[Payment] Processing payment: ${amount} ${currency}`);
    return { transactionId: 'txn_456', success: true };
  },
  refund: async (transactionId: string) => {
    console.log(`[Payment] Processing refund for: ${transactionId}`);
    return { success: true };
  },
  checkBalance: async () => {
    console.log(`[Payment] Checking balance`);
    return { balance: 1000, currency: 'USD' };
  },
});

agent.addDomain('analytics', {
  trackEvent: async (
    eventName: string,
    properties: Record<string, unknown>
  ) => {
    console.log(`[Analytics] Tracking event: ${eventName}`, properties);
    return { success: true };
  },
  generateReport: async (
    reportType: string,
    dateRange: { start: Date; end: Date }
  ) => {
    console.log(`[Analytics] Generating ${reportType} report`);
    return { report: {} };
  },
});

// Create routes with domain scoping
agent.createRoute({
  title: 'Data Collection',
  description: 'Collect and process web data',
  conditions: ['User wants to scrape or extract data from websites'],
  domains: ['scraping'], // ✅ Only scraping tools available
});

agent.createRoute({
  title: 'Schedule Meeting',
  description: 'Book and manage appointments',
  conditions: ['User wants to schedule, view, or cancel events'],
  domains: ['calendar'], // ✅ Only calendar tools available
});

agent.createRoute({
  title: 'Checkout Process',
  description: 'Process purchases and payments',
  conditions: ['User wants to make a purchase or payment'],
  domains: ['payment', 'analytics'], // ✅ Multiple domains allowed
});

agent.createRoute({
  title: 'Customer Support',
  description: 'Answer general questions and provide help',
  conditions: ['User has general questions or needs support'],
  domains: [], // ✅ No tools available (conversation only)
});

agent.createRoute({
  title: 'Admin Support',
  description: 'Administrative tasks with full access',
  conditions: ['User is admin and needs full system access'],
  // domains not specified = all domains available
});

// Example conversations
async function demonstrateScoping() {
  console.log('\n=== Domain Scoping Demo ===\n');

  // Example 1: Data Collection route - only scraping tools available
  console.log('1️⃣  Example: User wants to scrape data');
  const history1 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      'Alice',
      'Can you scrape the homepage of example.com?'
    ),
  ];

  const response1 = await agent.respond({ history: history1 });
  console.log(`Route chosen: ${response1.route?.title}`);
  console.log(`Available tools in this route: scraping only`);
  console.log(`Response: ${response1.message}\n`);

  // Example 2: Schedule Meeting route - only calendar tools available
  console.log('2️⃣  Example: User wants to schedule a meeting');
  const history2 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      'Bob',
      'Schedule a meeting for tomorrow at 2pm'
    ),
  ];

  const response2 = await agent.respond({ history: history2 });
  console.log(`Route chosen: ${response2.route?.title}`);
  console.log(`Available tools in this route: calendar only`);
  console.log(`Response: ${response2.message}\n`);

  // Example 3: Customer Support route - NO tools available
  console.log('3️⃣  Example: User has a general question');
  const history3 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      'Charlie',
      'What are your business hours?'
    ),
  ];

  const response3 = await agent.respond({ history: history3 });
  console.log(`Route chosen: ${response3.route?.title}`);
  console.log(`Available tools in this route: none (conversation only)`);
  console.log(`Response: ${response3.message}\n`);

  // Example 4: Admin Support route - ALL tools available (for demo purposes)
  console.log('4️⃣  Example: Admin needs full access');
  const history4 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      'Admin',
      'I need to generate a report and process a refund'
    ),
  ];

  const response4 = await agent.respond({ history: history4 });
  console.log(`Route chosen: ${response4.route?.title}`);
  console.log(`Available tools in this route: all domains`);
  console.log(`Response: ${response4.message}\n`);
}

// Benefits demonstration
console.log(`
🔒 Security Benefits:
- Customer Support route cannot accidentally call payment.processPayment()
- Data Collection route cannot access calendar.scheduleEvent()
- Each route has minimum necessary permissions

⚡ Performance Benefits:
- AI only sees relevant tools for each route
- Faster decision making with reduced context
- Clearer intent and fewer errors

🎯 Clarity Benefits:
- Routes clearly document their capabilities
- Easy to audit what each route can do
- Better debugging when tools are called
`);

// Inspect route configurations
console.log('\n📋 Route Configurations:\n');
for (const route of agent.getRoutes()) {
  const domains = route.getDomains();
  const domainsText =
    domains === undefined
      ? 'all domains'
      : domains.length === 0
      ? 'no tools (conversation only)'
      : domains.join(', ');

  console.log(`• ${route.title}: ${domainsText}`);
}

// Validate tool calls (example helper function)
function validateToolCall(toolName: string, routeTitle: string): boolean {
  const route = agent.getRoutes().find((r) => r.title === routeTitle);
  if (!route) return false;

  const allowedDomains = route.getDomains();

  // If undefined, all domains allowed
  if (allowedDomains === undefined) return true;

  // If empty array, no tools allowed
  if (allowedDomains.length === 0) return false;

  // Check if tool's domain is in allowed list
  const [domain] = toolName.split('.');
  return allowedDomains.includes(domain);
}

console.log('\n✅ Validation Examples:');
console.log(
  `- scraping.scrapeSite in "Data Collection": ${validateToolCall(
    'scraping.scrapeSite',
    'Data Collection'
  )}`
);
console.log(
  `- calendar.scheduleEvent in "Data Collection": ${validateToolCall(
    'calendar.scheduleEvent',
    'Data Collection'
  )}`
);
console.log(
  `- payment.processPayment in "Customer Support": ${validateToolCall(
    'payment.processPayment',
    'Customer Support'
  )}`
);
console.log(
  `- analytics.trackEvent in "Admin Support": ${validateToolCall(
    'analytics.trackEvent',
    'Admin Support'
  )}`
);

// Run demonstration
if (require.main === module) {
  demonstrateScoping().catch(console.error);
}
