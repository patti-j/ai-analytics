import { useState, useRef, useEffect } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';

interface MultiSelectFilterProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  labels?: Record<string, string>;
  hasAllAccess?: boolean;
  width?: string;
  testId?: string;
}

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  labels,
  hasAllAccess = false,
  width = 'w-[180px]',
  testId,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && searchRef.current) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
    if (!open) setSearch('');
  }, [open]);

  const getLabel = (value: string) => labels?.[value] || value;

  const filteredOptions = options.filter(
    (o) => o !== 'None' && getLabel(o).toLowerCase().includes(search.toLowerCase())
  );

  const isAllSelected = selected.length === 0 || (hasAllAccess && selected.includes('__all__'));

  const handleAllToggle = () => {
    if (isAllSelected) {
      return;
    }
    onChange([]);
  };

  const handleOptionToggle = (option: string) => {
    if (isAllSelected) {
      onChange([option]);
    } else if (selected.includes(option)) {
      const next = selected.filter((s) => s !== option);
      if (next.length === 0) {
        onChange([]);
      } else {
        onChange(next);
      }
    } else {
      onChange([...selected, option]);
    }
  };

  const displayText = () => {
    if (isAllSelected) return 'All';
    if (selected.length === 1) return getLabel(selected[0]);
    return `${selected.length} selected`;
  };

  const clearSelection = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium whitespace-nowrap text-foreground/80">{label}:</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'h-8 justify-between text-sm font-normal px-2.5',
              width,
              !isAllSelected && selected.length > 0 && 'border-primary/50'
            )}
            data-testid={testId}
          >
            <span className="truncate">{displayText()}</span>
            <div className="flex items-center gap-0.5 ml-1 shrink-0">
              {!isAllSelected && selected.length > 0 && (
                <X
                  className="h-3.5 w-3.5 opacity-50 hover:opacity-100 cursor-pointer"
                  onClick={clearSelection}
                  data-testid={`${testId}-clear`}
                />
              )}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </div>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[220px]" align="start">
          {filteredOptions.length > 8 && (
            <div className="p-2 border-b border-border/50">
              <input
                ref={searchRef}
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-7 px-2 text-sm bg-transparent border border-border/50 rounded outline-none focus:border-primary/50"
                data-testid={`${testId}-search`}
              />
            </div>
          )}
          <ScrollArea className="max-h-[280px]">
            <div className="p-1">
              <label
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-accent text-sm',
                  isAllSelected && 'bg-accent/50'
                )}
                data-testid={`${testId}-option-all`}
              >
                <Checkbox
                  checked={isAllSelected}
                  onCheckedChange={handleAllToggle}
                />
                <span className="font-medium">All</span>
              </label>
              <div className="h-px bg-border/30 my-1" />
              {filteredOptions.map((option) => (
                <label
                  key={option}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-accent text-sm',
                    !isAllSelected && selected.includes(option) && 'bg-accent/50'
                  )}
                  data-testid={`${testId}-option-${option}`}
                >
                  <Checkbox
                    checked={!isAllSelected && selected.includes(option)}
                    onCheckedChange={() => handleOptionToggle(option)}
                  />
                  <span className="truncate">{getLabel(option)}</span>
                </label>
              ))}
              {filteredOptions.length === 0 && (
                <div className="px-2 py-3 text-sm text-muted-foreground text-center">
                  No matches
                </div>
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
