# WebCLI access to the AI Browser

A trusted main-process launcher can delegate one CLI invocation to
`runWebCli({ cliPath, context, command, args, signal })`. Supply the absolute
JavaScript entry from the installed CLI record and the AI Browser context that
owns the task. Only the command and its validated business arguments come from
the model. The caller owns installation, version selection and user consent.

`runWebCli` starts that entry once in Electron's Node runtime. Call it at the
point where the launcher would start its child. Protocol v1 requires a
compatible CLI: it reads `WEBCLI_HOST_ENDPOINT` and `WEBCLI_HOST_TOKEN` from
its child environment and sends authenticated JSON requests to the loopback
endpoint for this invocation. An enabled host transport must report failures
to the caller and must never fall back to an external browser. A launcher with
its own child lifecycle would need to integrate this channel at process creation.

The host binds each request to the original command. The trusted CLI resolves
the installed Adapter, validates its manifest and prepares its host and page
grants. Only pass confirmed writes after checking the user's approval in the
calling layer. Background requests use the existing Electron browser session
and check the product's browser policy and the Adapter's declared hosts.
Page Adapters use context-owned Halo pages. The browser keeps its normal page
ownership and login lifecycle. Screenshot results contain a workspace file path.

Each call owns a short-lived listener, a credential, a child and an abort
signal. Concurrent calls on the same context fail busy. Timeout, cancellation
and app shutdown terminate the invocation without replaying it. CLI state
is scoped to the Halo profile. Nothing is registered or launched at app startup.

This module is a launcher integration point. The distribution service, model
tool registration and the skill that chooses a command are outside its scope.
The host tests use local fixtures, including actual CLI child processes.
