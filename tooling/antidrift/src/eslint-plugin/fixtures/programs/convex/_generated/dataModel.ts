import type { GenericId } from "convex/values";

export type MachineEndpoint = {
  url: string;
  port: number;
  protocols: string[];
  priority: number;
};

export interface DataModel {
  machines: {
    document: {
      _id: Id<"machines">;
      _creationTime: number;
      name: string;
      endpoints: MachineEndpoint[];
    };
    fieldPaths: string;
    indexes: Record<string, unknown>;
    searchIndexes: Record<string, unknown>;
    vectorIndexes: Record<string, unknown>;
  };
}

export type TableNames = keyof DataModel;

export type Doc<TableName extends TableNames> =
  DataModel[TableName]["document"];

export type Id<TableName extends string> = GenericId<TableName>;
