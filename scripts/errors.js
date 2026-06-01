export class SourceGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceGenerationError";
  }
}
