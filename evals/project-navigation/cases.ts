export const navigationModes = ["none", "current", "graph"] as const;
export type NavigationMode = (typeof navigationModes)[number];

export const navigationCases = [
  {
    id: "dashboard-personal",
    start: "dashboard",
    goal: "Reach my personal details editor",
    path: "/pim/viewPersonalDetails/",
    heading: "Personal Details",
  },
  {
    id: "login-candidate",
    start: "signed-out",
    goal: "Reach the form for adding a recruitment candidate without submitting it",
    path: "/recruitment/addCandidate",
    heading: "Add Candidate",
  },
  {
    id: "dashboard-holidays",
    start: "dashboard",
    goal: "Reach the list of public holidays the organization observes",
    path: "/leave/viewHolidayList",
    heading: "Holidays",
  },
  {
    id: "dashboard-pay-grades",
    start: "dashboard",
    goal: "Reach the screen where salary bands for jobs are defined",
    path: "/admin/viewPayGrades",
    heading: "Pay Grades",
  },
  {
    id: "dashboard-org-structure",
    start: "dashboard",
    goal: "Reach the company's department tree",
    path: "/admin/viewCompanyStructure",
    heading: "Organization Structure",
  },
  {
    id: "dashboard-kpis",
    start: "dashboard",
    goal: "Reach the screen where performance indicators used in reviews are set up",
    path: "/performance/searchKpi",
    heading: "Key Performance Indicators for Job Title",
  },
  {
    id: "dashboard-customers",
    start: "dashboard",
    goal: "Reach the list of clients that employee time can be tracked against",
    path: "/time/viewCustomers",
    heading: "Customers",
  },
  {
    id: "holidays-to-pay-grades",
    start: "/leave/viewHolidayList",
    goal: "Reach the screen where salary bands for jobs are defined",
    path: "/admin/viewPayGrades",
    heading: "Pay Grades",
    clicksOnly: true,
  },
  {
    id: "pay-grades-to-kpis",
    start: "/admin/viewPayGrades",
    goal: "Reach the screen where performance indicators used in reviews are set up",
    path: "/performance/searchKpi",
    heading: "Key Performance Indicators for Job Title",
    clicksOnly: true,
  },
  {
    id: "kpis-to-customers",
    start: "/performance/searchKpi",
    goal: "Reach the list of clients that employee time can be tracked against",
    path: "/time/viewCustomers",
    heading: "Customers",
    clicksOnly: true,
  },
  {
    id: "customers-to-holidays",
    start: "/time/viewCustomers",
    goal: "Reach the list of public holidays the organization observes",
    path: "/leave/viewHolidayList",
    heading: "Holidays",
    clicksOnly: true,
  },
  {
    id: "org-structure-to-candidate",
    start: "/admin/viewCompanyStructure",
    goal: "Reach the form for adding a recruitment candidate without submitting it",
    path: "/recruitment/addCandidate",
    heading: "Add Candidate",
    clicksOnly: true,
  },
  {
    id: "login-to-customers-clicks",
    start: "signed-out",
    goal: "Reach the list of clients that employee time can be tracked against",
    path: "/time/viewCustomers",
    heading: "Customers",
    clicksOnly: true,
  },
] as const;
export type NavigationCase = (typeof navigationCases)[number];
export const navigationOrigin = "https://opensource-demo.orangehrmlive.com";

export interface NavigationTrial {
  readonly id: string;
  readonly caseId: string;
  readonly mode: NavigationMode;
  readonly repetition: number;
}

export function navigationSchedule(samples: number, seed: number): NavigationTrial[] {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100)
    throw new Error("samples must be between 1 and 100");
  const rows = navigationCases.flatMap((item) =>
    navigationModes.flatMap((mode) =>
      Array.from({ length: samples }, (_, repetition) => ({
        id: `${item.id}-${mode}-${repetition}`,
        caseId: item.id,
        mode,
        repetition,
      })),
    ),
  );
  let value = seed >>> 0;
  for (let index = rows.length - 1; index > 0; index -= 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const other = value % (index + 1);
    [rows[index], rows[other]] = [rows[other]!, rows[index]!];
  }
  return rows;
}
