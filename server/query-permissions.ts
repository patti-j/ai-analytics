import { AiUserEntitlement, ScopeType } from '@shared/schema';
import { log } from './index';

const PLANNING_AREA_COLUMN = 'PlanningAreaName';
const SCENARIO_COLUMN = 'NewScenarioId';

interface TableColumnMapping {
  planningArea?: string;
  scenario?: string;
  plant?: string;
  resource?: string;
  product?: string;
  workcenter?: string;
}

const TABLE_COLUMN_MAPPINGS: Record<string, TableColumnMapping> = {
  'DASHt_Planning': { planningArea: 'PlanningAreaName', scenario: 'NewScenarioId', plant: 'BlockPlant', product: 'ProductName' },
  'DASHt_SalesOrders': { planningArea: 'PlanningAreaName', scenario: 'NewScenarioId' },
  'DASHt_SalesOrderLines': { planningArea: 'PlanningAreaName', scenario: 'NewScenarioId' },
  'DASHt_CapacityPlanning': { planningArea: 'PlanningAreaName', scenario: 'NewScenarioId', plant: 'PlantName' },
  'DASHt_DispatchList': { planningArea: 'PlanningAreaName', scenario: 'NewScenarioId', plant: 'PlantName' },
  'DASHt_Inventories': { planningArea: 'PlanningAreaName', scenario: 'NewScenarioId' },
  'DASHt_ScheduleConformance': { planningArea: 'PlanningAreaName', plant: 'PlantName' },
  'Jobs': { planningArea: 'PlanningAreaName', scenario: 'NewScenarioId', plant: 'Plant' },
  'DASHt_Resources': { planningArea: 'PlanningAreaName', plant: 'PlantName', resource: 'ResourceName', workcenter: 'WorkcenterName' },
  'DASHt_CapacityPlanning_ResourceDemand': { resource: 'ResourceName', plant: 'PlantName' },
  'DASHt_CapacityPlanning_ResourceCapacity': { resource: 'ResourceName', plant: 'PlantName' },
  'DASHt_CapacityPlanning_ShiftsCombined': { resource: 'ResourceName' },
};

const SCOPE_TO_COLUMN_KEY: Record<ScopeType, keyof TableColumnMapping> = {
  PlanningArea: 'planningArea',
  Plant: 'plant',
  Scenario: 'scenario',
  Resource: 'resource',
  Product: 'product',
  Workcenter: 'workcenter',
};

function extractTableNames(sql: string): string[] {
  const tablePattern = /(?:FROM|JOIN)\s+\[?publish\]?\.\[?(\w+)\]?/gi;
  const tables: string[] = [];
  let match;
  while ((match = tablePattern.exec(sql)) !== null) {
    tables.push(match[1]);
  }
  return Array.from(new Set(tables));
}

function getColumnForScopeInTables(scopeKey: keyof TableColumnMapping, tables: string[]): string | null {
  for (const table of tables) {
    const mapping = TABLE_COLUMN_MAPPINGS[table];
    if (mapping && mapping[scopeKey]) {
      return mapping[scopeKey]!;
    }
  }
  return null;
}

function getPlantColumnForTables(tables: string[]): string | null {
  for (const table of tables) {
    const mapping = TABLE_COLUMN_MAPPINGS[table];
    if (mapping?.plant) {
      return mapping.plant;
    }
  }
  return null;
}

function hasColumnInTables(columnName: string, tables: string[]): boolean {
  const columnsPerTable: Record<string, string[]> = {
    'DASHt_Planning': ['PlanningAreaName', 'NewScenarioId', 'BlockPlant', 'ScenarioType', 'ProductName'],
    'DASHt_SalesOrders': ['PlanningAreaName', 'NewScenarioId', 'ScenarioType'],
    'DASHt_SalesOrderLines': ['PlanningAreaName', 'NewScenarioId'],
    'DASHt_CapacityPlanning': ['PlanningAreaName', 'NewScenarioId', 'PlantName'],
    'DASHt_DispatchList': ['PlanningAreaName', 'NewScenarioId', 'PlantName'],
    'DASHt_Inventories': ['PlanningAreaName', 'NewScenarioId'],
    'DASHt_ScheduleConformance': ['PlanningAreaName', 'PlantName'],
    'Jobs': ['PlanningAreaName', 'NewScenarioId', 'Plant', 'ScenarioType'],
    'DASHt_Resources': ['PlanningAreaName', 'PlantName', 'ResourceName', 'WorkcenterName'],
    'DASHt_CapacityPlanning_ResourceDemand': ['ResourceName', 'PlantName'],
    'DASHt_CapacityPlanning_ResourceCapacity': ['ResourceName', 'PlantName'],
    'DASHt_CapacityPlanning_ShiftsCombined': ['ResourceName'],
  };

  for (const table of tables) {
    const tableColumns = columnsPerTable[table];
    if (tableColumns && tableColumns.includes(columnName)) {
      return true;
    }
  }
  return false;
}

function getTableAlias(sql: string, tableName: string): string | null {
  const aliasPattern = new RegExp(
    `(?:FROM|JOIN)\\s+\\[?publish\\]?\\.\\[?${tableName}\\]?(?:\\s+(?:AS\\s+)?(\\w+))?`,
    'gi'
  );
  let match;
  while ((match = aliasPattern.exec(sql)) !== null) {
    if (match[1]) {
      const keyword = match[1].toUpperCase();
      if (['WHERE', 'ON', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'FULL', 'JOIN', 'GROUP', 'ORDER', 'HAVING', 'UNION'].includes(keyword)) {
        continue;
      }
      return match[1];
    }
  }
  return null;
}


function injectWhereClause(sql: string, filterClause: string): string {
  if (!filterClause) return sql;

  // Use regex to handle multi-line SQL with various whitespace
  const whereMatch = sql.match(/\bWHERE\b/i);
  const groupByMatch = sql.match(/\bGROUP\s+BY\b/i);
  const orderByMatch = sql.match(/\bORDER\s+BY\b/i);
  const havingMatch = sql.match(/\bHAVING\b/i);

  // If WHERE exists, add to it
  if (whereMatch && whereMatch.index !== undefined) {
    const insertPosition = whereMatch.index + whereMatch[0].length;
    return sql.slice(0, insertPosition) + ` (${filterClause}) AND` + sql.slice(insertPosition);
  }

  // Find the earliest clause after FROM where we need to insert WHERE
  let insertBefore = sql.length;
  if (groupByMatch && groupByMatch.index !== undefined) {
    insertBefore = Math.min(insertBefore, groupByMatch.index);
  }
  if (orderByMatch && orderByMatch.index !== undefined) {
    insertBefore = Math.min(insertBefore, orderByMatch.index);
  }
  if (havingMatch && havingMatch.index !== undefined) {
    insertBefore = Math.min(insertBefore, havingMatch.index);
  }

  // Insert WHERE clause before GROUP BY/ORDER BY/HAVING or at the end
  return sql.slice(0, insertBefore).trimEnd() + ` WHERE ${filterClause} ` + sql.slice(insertBefore);
}

export interface GlobalFilters {
  planningArea?: string | null;
  scenario?: string | null;
  scenarioId?: string | null;
  plant?: string | null;
  resource?: string | null;
  product?: string | null;
  workcenter?: string | null;
}

export function applyGlobalFilters(
  sql: string,
  filters: GlobalFilters
): { modifiedSql: string; appliedFilters: string[] } {
  const tables = extractTableNames(sql);
  const conditions: string[] = [];
  const appliedFilters: string[] = [];

  if (filters.planningArea && filters.planningArea !== 'None') {
    if (hasColumnInTables(PLANNING_AREA_COLUMN, tables)) {
      const value = filters.planningArea.replace(/'/g, "''");
      conditions.push(`${PLANNING_AREA_COLUMN} = '${value}'`);
      appliedFilters.push(`Planning Area: ${filters.planningArea}`);
    }
  }

  if (filters.scenarioId) {
    if (hasColumnInTables(SCENARIO_COLUMN, tables)) {
      const value = filters.scenarioId.replace(/'/g, "''");
      conditions.push(`${SCENARIO_COLUMN} = '${value}'`);
      appliedFilters.push(`Scenario ID: ${filters.scenarioId}`);
    }
  }

  if (filters.plant && filters.plant !== 'None') {
    const plantColumn = getPlantColumnForTables(tables);
    if (plantColumn) {
      const value = filters.plant.replace(/'/g, "''");
      conditions.push(`${plantColumn} = '${value}'`);
      appliedFilters.push(`Plant: ${filters.plant}`);
    }
  }

  if (filters.resource && filters.resource !== 'None') {
    const match = getColumnForScopeInTables('resource', tables);
    if (match) {
      const value = filters.resource.replace(/'/g, "''");
      conditions.push(`${match} = '${value}'`);
      appliedFilters.push(`Resource: ${filters.resource}`);
    }
  }

  if (filters.product && filters.product !== 'None') {
    const match = getColumnForScopeInTables('product', tables);
    if (match) {
      const value = filters.product.replace(/'/g, "''");
      conditions.push(`${match} = '${value}'`);
      appliedFilters.push(`Product: ${filters.product}`);
    }
  }

  if (filters.workcenter && filters.workcenter !== 'None') {
    const match = getColumnForScopeInTables('workcenter', tables);
    if (match) {
      const value = filters.workcenter.replace(/'/g, "''");
      conditions.push(`${match} = '${value}'`);
      appliedFilters.push(`Workcenter: ${filters.workcenter}`);
    }
  }

  if (conditions.length === 0) {
    return { modifiedSql: sql, appliedFilters: [] };
  }

  const filterClause = conditions.join(' AND ');
  const modifiedSql = injectWhereClause(sql, filterClause);
  
  log(`[global-filters] Applied: ${appliedFilters.join('; ')}`, 'permissions');
  log(`[global-filters] Modified SQL: ${modifiedSql}`, 'permissions');
  
  return { modifiedSql, appliedFilters };
}

export interface EntitlementEnforcementResult {
  allowed: boolean;
  modifiedSql?: string;
  blockedReason?: string;
  appliedFilters?: string[];
}

function groupEntitlementsByScope(entitlements: AiUserEntitlement[]): Map<ScopeType, string[]> {
  const grouped = new Map<ScopeType, string[]>();
  for (const e of entitlements) {
    const existing = grouped.get(e.ScopeType as ScopeType) || [];
    existing.push(e.ScopeValue);
    grouped.set(e.ScopeType as ScopeType, existing);
  }
  return grouped;
}

function getColumnForScope(scopeType: ScopeType, tables: string[]): { column: string; table: string } | null {
  const columnKey = SCOPE_TO_COLUMN_KEY[scopeType];
  for (const table of tables) {
    const mapping = TABLE_COLUMN_MAPPINGS[table];
    if (mapping && mapping[columnKey]) {
      return { column: mapping[columnKey]!, table };
    }
  }
  return null;
}

export function enforceEntitlements(
  sql: string,
  entitlements: AiUserEntitlement[],
  isAdmin: boolean
): EntitlementEnforcementResult {
  if (isAdmin) {
    log('[entitlements] Admin user — skipping entitlement enforcement', 'permissions');
    return { allowed: true, modifiedSql: sql, appliedFilters: [] };
  }

  if (entitlements.length === 0) {
    log('[entitlements] User has 0 entitlements — blocking query', 'permissions');
    return {
      allowed: false,
      blockedReason: 'Your permissions have not been configured yet. Please contact your administrator to set up your data access.',
    };
  }

  const tables = extractTableNames(sql);
  if (tables.length === 0) {
    return { allowed: true, modifiedSql: sql, appliedFilters: [] };
  }

  const grouped = groupEntitlementsByScope(entitlements);
  const conditions: string[] = [];
  const appliedFilters: string[] = [];

  for (const [scopeType, values] of grouped) {
    const match = getColumnForScope(scopeType, tables);
    if (!match) continue;

    const alias = getTableAlias(sql, match.table);
    const prefix = alias || `[publish].[${match.table}]`;
    const escaped = values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
    conditions.push(`${prefix}.${match.column} IN (${escaped})`);
    appliedFilters.push(`${scopeType}: ${values.join(', ')}`);
  }

  if (conditions.length === 0) {
    return { allowed: true, modifiedSql: sql, appliedFilters: [] };
  }

  const filterClause = conditions.join(' AND ');
  const modifiedSql = injectWhereClause(sql, filterClause);

  log(`[entitlements] Applied filters: ${appliedFilters.join('; ')}`, 'permissions');
  log(`[entitlements] Modified SQL: ${modifiedSql}`, 'permissions');

  return { allowed: true, modifiedSql, appliedFilters };
}

export function intersectFilterOptions(
  allValues: string[],
  entitledValues: string[] | undefined,
  isAdmin: boolean
): string[] {
  if (isAdmin || !entitledValues || entitledValues.length === 0) {
    return allValues;
  }
  const entitled = new Set(entitledValues.map(v => v.toLowerCase()));
  return allValues.filter(v => entitled.has(v.toLowerCase()));
}
