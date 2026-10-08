'use strict';

// The ticket-context file (tests/cases/.ticket-context/<ID>.json) is what analyze-code,
// create-manual-test-cases and the other pipeline commands read. Its shape predates the adapters,
// so this maps a normalized ticket onto it — in code, instead of as field-by-field prose.
function toTicketContext(ticket) {
  return {
    ticketId: ticket.id,
    source: ticket.source,
    url: ticket.url || '',
    summary: ticket.title,
    issueType: ticket.type,
    status: ticket.status,
    priority: ticket.priority || '',
    labels: ticket.labels,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    attachments: ticket.attachments,
    comments: ticket.comments,
    subtasks: ticket.subtasks,
  };
}

module.exports = { toTicketContext };
