import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Save, Users, Shield, ArrowLeft, RefreshCw, Search, ChevronRight } from 'lucide-react';
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
  CreatedAt: string;
  UpdatedAt: string;
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
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
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
        console.error(`[admin-users] Fetch users failed: ${response.status} ${response.statusText}`, errBody);
        throw new Error(errBody ? JSON.parse(errBody)?.error || `Server error (${response.status})` : `Server error (${response.status})`);
      }
      const data = await response.json();
      setUsers(data.users || []);
    } catch (error: any) {
      console.error('[admin-users] Failed to fetch users:', error.message);
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

  const handleSelectUser = async (email: string) => {
    setSelectedEmail(email);
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
    if (!selectedEmail) return;

    const scopes: { scopeType: ScopeType; scopeValue: string }[] = [];
    for (const [scopeType, values] of editedScopes) {
      for (const value of values) {
        scopes.push({ scopeType: scopeType as ScopeType, scopeValue: value });
      }
    }

    try {
      setSaving(true);
      const response = await fetch(apiUrl(`/api/admin/entitlements/users/${encodeURIComponent(selectedEmail)}`), {
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
        u.UserEmail === selectedEmail
          ? { ...u, hasEntitlements: scopes.length > 0, entitlementCount: scopes.length }
          : u
      ));

      toast({ title: 'Saved', description: `Entitlements updated for ${selectedEmail}` });
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
      <div className="max-w-7xl mx-auto p-6">
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

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-1">
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
                <div className="space-y-1 max-h-[600px] overflow-y-auto">
                  {filteredUsers.map((user) => (
                    <div
                      key={user.UserEmail}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors flex items-center justify-between ${
                        selectedEmail === user.UserEmail
                          ? 'border-primary bg-primary/5'
                          : 'hover:bg-muted/50'
                      }`}
                      onClick={() => handleSelectUser(user.UserEmail)}
                      data-testid={`user-item-${user.UserEmail}`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{user.UserEmail}</div>
                        <div className="flex items-center gap-2 mt-1">
                          {user.hasEntitlements ? (
                            <Badge variant="secondary" className="text-xs">
                              {user.entitlementCount} scope{user.entitlementCount !== 1 ? 's' : ''}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              No scopes
                            </Badge>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Entitlements</CardTitle>
                  <CardDescription>
                    {selectedEmail
                      ? `Editing data access for ${selectedEmail}`
                      : 'Select a user to manage their data access'}
                  </CardDescription>
                </div>
                {selectedEmail && hasChanges && (
                  <Badge variant="outline" className="text-orange-600 border-orange-300">
                    Unsaved changes
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!selectedEmail ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Select a user from the list to manage their data access</p>
                </div>
              ) : loadingEntitlements ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="text-sm text-muted-foreground">
                    {totalEdited === 0
                      ? 'No scopes assigned. This user cannot run queries until at least one scope is granted.'
                      : `${totalEdited} scope${totalEdited !== 1 ? 's' : ''} assigned across ${editedScopes.size} type${editedScopes.size !== 1 ? 's' : ''}.`}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {SCOPE_TYPES.map((scopeType) => {
                      const available = scopeValues[scopeType] || [];
                      const selected = editedScopes.get(scopeType) || new Set();
                      const isLoadingValues = loadingScopeValues[scopeType];
                      const allSelected = available.length > 0 && selected.size === available.length;

                      return (
                        <div key={scopeType} className="space-y-3">
                          <div className="flex items-center justify-between">
                            <Label className="font-medium">{SCOPE_LABELS[scopeType]}</Label>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs h-7"
                                onClick={() => allSelected ? clearAllForScope(scopeType) : selectAllForScope(scopeType)}
                                disabled={available.length === 0}
                                data-testid={`button-toggle-all-${scopeType}`}
                              >
                                {allSelected ? 'Clear All' : 'Select All'}
                              </Button>
                            </div>
                          </div>
                          <div className="border rounded-lg p-3 max-h-48 overflow-y-auto space-y-2">
                            {isLoadingValues ? (
                              <div className="flex items-center justify-center py-2">
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                <span className="text-sm text-muted-foreground">Loading...</span>
                              </div>
                            ) : available.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No values available</p>
                            ) : (
                              available.map((value) => (
                                <div key={value} className="flex items-center space-x-2">
                                  <Checkbox
                                    id={`${scopeType}-${value}`}
                                    checked={selected.has(value)}
                                    onCheckedChange={() => toggleScope(scopeType, value)}
                                    data-testid={`checkbox-${scopeType}-${value}`}
                                  />
                                  <Label htmlFor={`${scopeType}-${value}`} className="text-sm cursor-pointer">
                                    {value}
                                  </Label>
                                </div>
                              ))
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {selected.size} of {available.length} selected
                          </p>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex justify-end pt-4 border-t">
                    <Button onClick={handleSave} disabled={saving || !hasChanges} data-testid="button-save-entitlements">
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
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
