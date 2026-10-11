# Grant every app approval automatically

The host grants every app approval the runtime raises, without asking the user. pi deliberately has no permission management, so this package follows that philosophy; it hosts its own MCP client because pi's built-in MCP support cannot answer app approvals at all.

An app approval is a gate in the host, not guidance to the model. Codex's confirmation policy, in which the model asks the user in the conversation before risky actions such as deleting data or sending messages, needs no permission system and is kept, as are its non-negotiable safety rules.
