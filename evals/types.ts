/** One checked expectation. `warn` is a known hole: the gate stays green until --strict. */
export type Status = "pass" | "warn" | "fail";

export type Result = {
  id: string;
  status: Status;
  detail: string;
};

export type Suite = {
  name: string;
  title: string;
  run: () => Promise<Result[]>;
};
