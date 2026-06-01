export const setOptionValue = (optionKey) => ({ options, readValue }) => {
  options[optionKey] = readValue();
};

export const setOptionFlag = (optionKey, flagValue = true) => ({ options }) => {
  options[optionKey] = flagValue;
};

export const parseOptions = (cliArguments, defaults, handlers, createError = (message) => new Error(message)) => {
  const argumentQueue = [...cliArguments];
  const options = { ...defaults };

  const readValue = (optionName) => {
    const optionValue = argumentQueue.shift();

    if (!optionValue || optionValue.startsWith("--")) {
      throw createError(`${optionName} requires a value.`);
    }

    return optionValue;
  };

  while (argumentQueue.length > 0) {
    const optionName = argumentQueue.shift();
    const optionHandler = handlers[optionName];

    if (!optionHandler) {
      throw createError(`Unknown option: ${optionName}`);
    }

    optionHandler({
      options,
      readValue: () => readValue(optionName),
    });
  }

  return options;
};
