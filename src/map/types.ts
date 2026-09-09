export type ModuleNode = {
  path: string;
  language: "ts" | "js";
  imports: string[];
};

export type ModuleEdge = {
  from: string;
  to: string;
  kind: "import" | "dynamic_import";
  /**
   * Names the dependant uses from the dependency, when the source graph knows
   * them. The regex import map does not, so this is absent there.
   */
  symbols?: string[];
};

export type ArchitectureMap = {
  modules: ModuleNode[];
  edges: ModuleEdge[];
};

export type MapQuery = {
  from?: string;
  to?: string;
  limit?: number;
};
