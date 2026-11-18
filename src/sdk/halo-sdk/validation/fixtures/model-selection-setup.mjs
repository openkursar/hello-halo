export async function setup(options, data) {
  const { createProvider } = await import(data.nativeEntry);
  const host = options.collaboration.modelSelection;
  const prepare = host.prepare;
  return {
    ...options,
    collaboration: {
      ...options.collaboration,
      modelSelection: {
        ...host,
        async prepare(request, context) {
          const { providerConfig, ...binding } = await prepare(request, context);
          const delegate = createProvider(providerConfig);
          const provider = {
            id: 'custom-child-facade',
            name: 'Custom child provider facade',
            capabilities: (...args) => delegate.capabilities(...args),
            createMessage: (...args) => delegate.createMessage(...args),
            createMessageStream: (...args) => delegate.createMessageStream(...args),
          };
          return { ...binding, provider };
        },
      },
    },
  };
}
