export type CodeBuddyCheckpointerOptions = {
  namespace?: string;
};

export class CodeBuddyCheckpointer {
  readonly options: CodeBuddyCheckpointerOptions;

  constructor(options: CodeBuddyCheckpointerOptions = {}) {
    this.options = options;
  }
}
