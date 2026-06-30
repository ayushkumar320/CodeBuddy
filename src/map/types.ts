export type ModuleNode = {
  path: string;
  language: "ts" | "js";
  imports: string[];
};

export type ModuleEdge = {
  from: string;
  to: string;
  kind: "import" | "dynamic_import";
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
