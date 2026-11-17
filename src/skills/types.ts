export type SkillSource = "project" | "global" | "configured";

export type SkillMetadata = {
  name: string;
  description: string;
  version?: string;
  license?: string;
  author?: string;
  allowedTools?: string[];
  tags?: string[];
};

export type Skill = {
  name: string;
  description: string;
  instructions: string;
  directory: string;
  skillFile: string;
  source: SkillSource;
  metadata: SkillMetadata;
  hasScripts: boolean;
  hasReferences: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type RegistrySkill = {
  name: string;
  description: string;
  url: string;
  version?: string;
  tags?: string[];
};

export type InstallRecord = {
  source: string;
  sourceType: "local" | "git" | "content" | "registry";
  installedAt: string;
  version?: string;
};
