import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Save, Users, Shield, ArrowLeft, RefreshCw, Search, ChevronRight, ChevronDown } from 'lucide-react';
import { Link } from 'wouter';
import { ThemeToggle } from '@/components/theme-toggle';
import { useToast } from '@/hooks/use-toast';
import { useEmbedSession } from '@/contexts/EmbedSessionContext';
import { SCOPE_TYPES, type ScopeType, type AiUserEntitlement } from '@shared/schema';
import { apiUrl } from '@/lib/api-config';

interface UserRow {
  CompanyId: number;
  UserEmail: string;
  IsActive: boolean;
  hasEntitlements: boolean;
  entitlementCount: number;
}

const SCOPE_LABELS: Record<ScopeType, string> = {
  PlanningArea: 'Planning Areas',
  Plant: 'Plants',
  Scenario: 'Scenarios',
  Resource: 'Resources',
  Product: 'Products',
  Workcenter: 'Workcenters',
};

export default function AdminUsers() {
  const { isCompanyAdmin } = useEmbedSession();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);
  const [entitlements, setEntitlements] = useState<AiUserEntitlement[]>([]);
  const [scopeValues, setScopeValues] = useState<Record<string, string[]>>({});
  const [loadingScopeValues, setLoadingScopeValues] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingEntitlements, setLoadingEntitlements] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedScopes, setEditedScopes] = useState<Map<string, Set<string>>>(new Map());
  const [hasChanges, setHasChanges] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchUsers();
  }, []);

  const filteredUsers = useMemo(() => {
    if (!searchQuery.trim()) return users;
    const q = searchQuery.toLowerCase();
    return users.filter(u => u.UserEmail.toLowerCase().includes(q));
  }, [users, searchQuery]);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch(apiUrl('/api/admin/entitlements/users'), { credentials: 'include' });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(errBody ? JSON.parse(errBody)?.error || `Server error (${response.status})` : `Server error (${response.status})`);
      }
      const data = await response.json();
      setUsers(data.users || []);
    } catch (error: any) {
      toast({ title: 'Unable to load users', description: error.message || 'Please try refreshing the page.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const fetchScopeValues = async (scopeType: string) => {
    if (scopeValues[scopeType]?.length > 0) return;

    try {
      setLoadingScopeValues(prev => ({ ...prev, [scopeType]: true }));
      const response = await fetch(apiUrl(`/api/admin/entitlements/scope-values/${scopeType}`), { credentials: 'include' });
      if (!response.ok) throw new Error(`Failed to fetch ${scopeType} values`);
      const data = await response.json();
      setScopeValues(prev => ({ ...prev, [scopeType]: data.values || [] }));
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } finally {
      setLoadingScopeValues(prev => ({ ...prev, [scopeType]: false }));
    }
  };

  const handleToggleUser = async (email: string) => {
    if (expandedEmail === email) {
      setExpandedEmail(null);
      setHasChanges(false);
      return;
    }

    setExpandedEmail(email);
    setHasChanges(false);

    try {
      setLoadingEntitlements(true);
      const response = await fetch(apiUrl(`/api/admin/entitlements/users/${encodeURIComponent(email)}`), { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch entitlements');
      const data = await response.json();
      setEntitlements(data.entitlements || []);

      const scopeMap = new Map<string, Set<string>>();
      for (const ent of data.entitlements || []) {
        if (!scopeMap.has(ent.ScopeType)) {
          scopeMap.set(ent.ScopeType, new Set());
        }
        scopeMap.get(ent.ScopeType)!.add(ent.ScopeValue);
      }
      setEditedScopes(scopeMap);

      for (const scopeType of SCOPE_TYPES) {
        fetchScopeValues(scopeType);
      }
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } finally {
      setLoadingEntitlements(false);
    }
  };

  const toggleScope = (scopeType: string, value: string) => {
    setEditedScopes(prev => {
      const next = new Map(prev);
      const values = new Set(next.get(scopeType) || []);
      if (values.has(value)) {
        values.delete(value);
      } else {
        values.add(value);
      }
      if (values.size === 0) {
        next.delete(scopeType);
      } else {
        next.set(scopeType, values);
      }
      return next;
    });
    setHasChanges(true);
  };

  const selectAllForScope = (scopeType: string) => {
    const available = scopeValues[scopeType] || [];
    setEditedScopes(prev => {
      const next = new Map(prev);
      next.set(scopeType, new Set(available));
      return next;
    });
    setHasChanges(true);
  };

  const clearAllForScope = (scopeType: string) => {
    setEditedScopes(prev => {
      const next = new Map(prev);
      next.delete(scopeType);
      return next;
    });
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!expandedEmail) return;

    const scopes: { scopeType: ScopeType; scopeValue: string }[] = [];
    for (const [scopeType, values] of editedScopes) {
      for (const value of values) {
        scopes.push({ scopeType: scopeType as ScopeType, scopeValue: value });
      }
    }

    try {
      setSaving(true);
      const response = await fetch(apiUrl(`/api/admin/entitlements/users/${encodeURIComponent(expandedEmail)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scopes }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to save entitlements');
      }

      const data = await response.json();
      setEntitlements(data.entitlements || []);
      setHasChanges(false);

      setUsers(prev => prev.map(u =>
        u.UserEmail === expandedEmail
          ? { ...u, hasEntitlements: scopes.length > 0, entitlementCount: scopes.length }
          : u
      ));

      toast({ title: 'Saved', description: `Entitlements updated for ${expandedEmail}` });
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (!isCompanyAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" data-testid="admin-access-denied">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Access Denied
            </CardTitle>
            <CardDescription>You need Company Admin access to manage user entitlements.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/">
              <Button variant="outline" data-testid="link-back-home">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Query
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalEdited = Array.from(editedScopes.values()).reduce((sum, set) => sum + set.size, 0);

  return (
    <div className="min-h-screen bg-background" data-testid="admin-users-page">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="sm" data-testid="link-back-home">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <div>
              <h1 className="text-3xl font-bold flex items-center gap-2">
                <Shield className="h-8 w-8" />
                User Entitlements
              </h1>
              <p className="text-muted-foreground">Manage what data each user can access across planning areas, plants, scenarios, and more</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchUsers} data-testid="button-refresh">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <ThemeToggle />
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Users
            </CardTitle>
            <CardDescription>
              Users with the AI Analytics role
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-users"
                />
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="text-center py-8 space-y-3" data-testid="empty-users-state">
                <Users className="h-10 w-10 mx-auto text-muted-foreground/50" />
                {searchQuery ? (
                  <p className="text-sm text-muted-foreground">No users match your search.</p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-muted-foreground">No users found</p>
                    <p className="text-xs text-muted-foreground/70">
                      Users need the "AI_Analytics" role assigned in the main application to appear here.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredUsers.map((user) => {
                  const isExpanded = expandedEmail === user.UserEmail;

                  return (
                    <div key={user.UserEmail} className="border rounded-lg overflow-hidden" data-testid={`user-item-${user.UserEmail}`}>
                      <div
                        className={`p-4 cursor-pointer transition-colors flex items-center justify-between ${
                          isExpanded ? 'bg-primary/5 border-b' : 'hover:bg-muted/50'
                        }`}
                        onClick={() => handleToggleUser(user.UserEmail)}
                        data-testid={`button-toggle-user-${user.UserEmail}`}
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate">{user.UserEmail}</div>
                          <div className="flex items-center gap-2 mt-1">
                            {user.hasEntitlements ? (
                              <Badge variant="secondary" className="text-xs" data-testid={`badge-scopes-${user.UserEmail}`}>
                                {user.entitlementCount} scope{user.entitlementCount !== 1 ? 's' : ''}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs text-muted-foreground" data-testid={`badge-no-scopes-${user.UserEmail}`}>
                                No scopes
                              </Badge>
                            )}
                          </div>
                        </div>
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        )}
                      </div>

                      {isExpanded && (
                        <div className="p-4 bg-muted/20" data-testid={`panel-entitlements-${user.UserEmail}`}>
                          {loadingEntitlements ? (
                            <div className="flex items-center justify-center py-8">
                              <Loader2 className="h-6 w-6 animate-spin" />
                            </div>
                          ) : (
                            <div className="space-y-4">
                              <div className="flex items-center justify-between">
                                <div className="text-sm text-muted-foreground">
                                  {totalEdited === 0
                                    ? 'No scopes assigned. This user cannot run queries until at least one scope is granted.'
                                    : `${totalEdited} scope${totalEdited !== 1 ? 's' : ''} assigned across ${editedScopes.size} type${editedScopes.size !== 1 ? 's' : ''}.`}
                                </div>
                                {hasChanges && (
                                  <Badge variant="outline" className="text-orange-600 border-orange-300" data-testid="badge-unsaved-changes">
                                    Unsaved changes
                                  </Badge>
                                )}
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {SCOPE_TYPES.map((scopeType) => {
                                  const available = scopeValues[scopeType] || [];
                                  const selected = editedScopes.get(scopeType) || new Set();
                                  const isLoadingValues = loadingScopeValues[scopeType];
                                  const allSelected = available.length > 0 && selected.size === available.length;

                                  return (
                                    <div key={scopeType} className="space-y-2" data-testid={`scope-section-${scopeType}`}>
                                      <div className="flex items-center justify-between">
                                        <Label className="font-medium text-sm">{SCOPE_LABELS[scopeType]}</Label>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="text-xs h-6 px-2"
                                          onClick={() => allSelected ? clearAllForScope(scopeType) : selectAllForScope(scopeType)}
                                          disabled={available.length === 0}
                                          data-testid={`button-toggle-all-${scopeType}`}
                                        >
                                          {allSelected ? 'Clear' : 'All'}
                                        </Button>
                                      </div>
                                      <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1 bg-background">
                                        {isLoadingValues ? (
                                          <div className="flex items-center justify-center py-2">
                                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                            <span className="text-xs text-muted-foreground">Loading...</span>
                                          </div>
                                        ) : available.length === 0 ? (
                                          <p className="text-xs text-muted-foreground py-1">No values available</p>
                                        ) : (
                                          available.map((value) => (
                                            <div key={value} className="flex items-center space-x-2">
                                              <Checkbox
                                                id={`${user.UserEmail}-${scopeType}-${value}`}
                                                checked={selected.has(value)}
                                                onCheckedChange={() => toggleScope(scopeType, value)}
                                                data-testid={`checkbox-${scopeType}-${value}`}
                                              />
                                              <Label htmlFor={`${user.UserEmail}-${scopeType}-${value}`} className="text-xs cursor-pointer leading-tight">
                                                {value}
                                              </Label>
                                            </div>
                                          ))
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground">
                                        {selected.size}/{available.length} selected
                                      </p>
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="flex justify-end pt-3 border-t">
                                <Button
                                  size="sm"
                                  onClick={handleSave}
                                  disabled={saving || !hasChanges}
                                  data-testid="button-save-entitlements"
                                >
                                  {saving ? (
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  ) : (
                                    <Save className="h-4 w-4 mr-2" />
                                  )}
                                  Save Entitlements
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
