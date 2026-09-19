# Use Helm Run as the shared capability scope

Pi Jev Helm treats every idle-to-settled unit of user work as a Helm Run, with Routed Run as the specialization for work where routing is attempted. Routing and Completion Verification remain optional deep modules in the same package and share the Helm Run identity without sharing provider or policy interfaces; this preserves locality and lets verification operate while Automatic Routing is off, instead of forcing a second extension to reconstruct private lifecycle state or limiting verification to routed work.
