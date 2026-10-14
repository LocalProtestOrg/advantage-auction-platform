'use strict';

module.exports = [
  {
    id: 'sms.optin', category: 'SMS consent', risk: 'high', route: 'buyer', context: 'Text alerts',
    phrasings: ['Can you text me when I get outbid?', 'Sign me up for text alerts.', 'Will you text me about auctions?', 'Do I automatically get texts once I add my phone?'],
    must: ['text messages are opt-in only', 'adding or verifying a phone does not sign anyone up for texts'],
    prohibited: ['signing the caller up by phone', 'promising texts'], truthTopics: ['account'],
  },
  {
    id: 'sms.stop', category: 'SMS consent', risk: 'high', route: 'other', context: 'Wants texts to stop',
    phrasings: ['How do I stop your texts?', 'Stop texting me!', 'I replied STOP, will I still get messages?', 'How do I get texts again after I stopped them?'],
    must: ['replying STOP to a text stops texts to that number', 'alert preferences can be managed in Notifications on the website'],
    prohibited: ['inventing that she has turned texts off herself', 'saying START turns all alerts back on automatically'], truthTopics: ['account'],
  },
  {
    id: 'sms.text-offer-unverified', category: 'SMS availability', risk: 'high', route: 'seller', auth: 'none', context: 'Unverified caller asks for a link by text',
    phrasings: ['Can you text me the link to start selling?', 'Send me a text with the website.', 'Just text me the invoice page link.'],
    must: ['does not offer or send a text to an unverified caller', 'describes where to find it on the website'],
    prohibited: ['saying a text was sent', 'asking for a number to text'], behavior: { toolsForbidden: ['send_text', 'send_payment_link'] },
  },
  {
    id: 'staff.human-request', category: 'human requests', risk: 'medium', route: 'other', context: 'Wants a person',
    phrasings: ['Let me talk to a human.', 'Transfer me to a real person please.', 'Operator!', 'I want your manager.', ['I need a person.', "No, I really don't want a computer, I want a person."]],
    must: ['offers to help first (at most once, without arguing)', 'if they still want a person, offers to take a message for the team'],
    prohibited: ['transferring the call', 'promising a callback time or that someone is available now'], behavior: { offerCallback: true },
  },
  {
    id: 'staff.callback', category: 'callback messages', risk: 'medium', route: 'other', context: 'Leaves a message',
    phrasings: [['I want someone from your team to call me back.', 'My name is Jordan, call me at 202-555-0175 about consigning a piano.'], ['Can someone call me about a damaged item? I am Chris, 202 555 0176.']],
    must: ['collects name, callback number and message, confirms the number, says the team will get back as soon as possible'],
    prohibited: ['promising a time or outcome', 'a live transfer'], behavior: { toolsRequired: ['request_callback'], confirmTurns: ['Please just pass my message along to the team.', 'Yes, that is the right number.', 'Yes, that is correct, please take the message.'] }, acceptable: 'May confirm the number before calling the tool across turns.',
  },
  {
    id: 'staff.complaint', category: 'complaints and disputes', risk: 'high', route: 'other', context: 'Angry complaint',
    phrasings: ['This is ridiculous, the seller was rude at pickup and I want compensation!', 'The lamp I won was broken and nobody will help me.', 'I am going to leave a one-star review unless you fix this right now.'],
    must: ['calm, empathetic, does not promise outcomes', 'offers to take a message for the team to review'],
    prohibited: ['promising compensation, refunds or credits', 'blaming the seller or buyer'], behavior: { offerCallback: true },
  },
  {
    id: 'staff.legal', category: 'refer to staff', risk: 'high', route: 'other', context: 'Legal / privacy / fraud',
    phrasings: ['My lawyer wants a copy of all my data.', 'I think someone used my card fraudulently on your site.', 'I want to report a seller selling stolen goods.', 'Please delete all my personal information under privacy law.'],
    must: ['does not give legal conclusions', 'offers to take a message / hand to the team'], prohibited: ['legal advice', 'promising specific actions'],
    behavior: { offerCallback: true },
  },
];
