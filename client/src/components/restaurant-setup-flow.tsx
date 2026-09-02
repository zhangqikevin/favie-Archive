import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  MapPin, CheckCircle2, ChefHat, ArrowRight, Loader2,
} from "lucide-react";
import { SiGoogle } from "react-icons/si";

const formSchema = z.object({
  name: z.string().min(2, "Restaurant name must be at least 2 characters"),
  address: z.string().min(5, "Please enter a full address"),
});

type FormValues = z.infer<typeof formSchema>;

type Step = "form" | "searching" | "results" | "done";

interface PlaceResult {
  displayName: { text: string };
  formattedAddress: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
}

function StarRating({ rating }: { rating: string }) {
  const num = parseFloat(rating);
  const full = Math.floor(num);
  const half = num - full >= 0.5;
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} className={cn(
          "w-3.5 h-3.5",
          i <= full ? "text-amber-400" : (half && i === full + 1) ? "text-amber-300" : "text-muted-foreground/30"
        )} fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
      <span className="text-xs font-semibold text-foreground ml-0.5">{rating}</span>
    </div>
  );
}

interface RestaurantSetupFlowProps {
  onComplete?: (restaurant: { id: string; name: string; address: string }) => void;
  compact?: boolean;
}

export default function RestaurantSetupFlow({ onComplete, compact }: RestaurantSetupFlowProps) {
  const [step, setStep] = useState<Step>("form");
  const [places, setPlaces] = useState<PlaceResult[]>([]);
  const [formValues, setFormValues] = useState<FormValues>({ name: "", address: "" });
  const [searchError, setSearchError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", address: "" },
  });

  const [createError, setCreateError] = useState<string | null>(null);
  const createMutation = useMutation({
    mutationFn: async (data: {
      name: string; address: string; rating?: string; reviewCount?: number;
      googleUrl?: string; yelpUrl?: string;
    }) => {
      const res = await apiRequest("POST", "/api/restaurants", data);
      return res.json();
    },
    onSuccess: (data) => {
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setStep("done");
      setTimeout(() => {
        onComplete?.(data.restaurant);
      }, 1200);
    },
    onError: (err: Error) => {
      setCreateError(err.message || "Failed to save restaurant");
    },
  });

  const handleSearch = async (values: FormValues) => {
    setFormValues(values);
    setStep("searching");
    setSearchError(null);
    try {
      const query = `${values.name} ${values.address}`;
      const res = await fetch(`/api/places/search?query=${encodeURIComponent(query)}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (data.places && data.places.length > 0) {
        setPlaces(data.places.slice(0, 5));
        setStep("results");
      } else {
        setPlaces([]);
        setStep("results");
      }
    } catch (e: any) {
      setSearchError(e.message || "Search failed");
      setStep("form");
    }
  };

  const handleConfirm = (place: PlaceResult) => {
    const name = place.displayName?.text || formValues.name;
    const address = place.formattedAddress || formValues.address;
    const yelpUrl = `https://www.yelp.com/search?find_desc=${encodeURIComponent(name)}&find_loc=${encodeURIComponent(address)}`;
    createMutation.mutate({
      name,
      address,
      rating: place.rating?.toFixed(1),
      reviewCount: place.userRatingCount,
      googleUrl: place.googleMapsUri,
      yelpUrl,
    });
  };

  const handleManualConfirm = () => {
    const yelpUrl = `https://www.yelp.com/search?find_desc=${encodeURIComponent(formValues.name)}&find_loc=${encodeURIComponent(formValues.address)}`;
    const googleUrl = `https://www.google.com/maps/search/${encodeURIComponent(formValues.name + " " + formValues.address)}`;
    createMutation.mutate({
      name: formValues.name,
      address: formValues.address,
      googleUrl,
      yelpUrl,
    });
  };

  if (step === "done") {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center text-center gap-3",
        compact ? "py-8" : "py-16"
      )}>
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle2 className="w-7 h-7 text-green-600" />
        </div>
        <div>
          <p className="text-base font-semibold text-foreground">Restaurant added!</p>
          <p className="text-sm text-muted-foreground mt-0.5">{formValues.name}</p>
        </div>
      </div>
    );
  }

  if (step === "searching") {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center text-center gap-4",
        compact ? "py-8" : "py-16"
      )}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
            <SiGoogle size={20} color="#4285F4" />
          </div>
          <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">Searching Google Maps…</p>
          <p className="text-xs text-muted-foreground mt-0.5">Looking for "{formValues.name}"</p>
        </div>
      </div>
    );
  }

  if (step === "results") {
    return (
      <div className={cn("space-y-4", compact && "")}>
        <div>
          <p className="text-sm font-semibold text-foreground">
            {places.length > 0 ? "We found your restaurant" : "No results found"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {places.length > 0
              ? "Select which listing is yours"
              : "You can add it manually or try a different search"}
          </p>
        </div>
        {createError && (
          <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded">{createError}</p>
        )}

        {places.length > 0 ? (
          <div className="space-y-2">
            {places.map((place, idx) => (
              <div
                key={idx}
                className="bg-background border border-border rounded-xl p-3 space-y-2"
              >
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <SiGoogle size={14} color="#4285F4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground leading-tight">
                      {place.displayName?.text}
                    </p>
                    <div className="flex items-start gap-1 mt-0.5">
                      <MapPin className="w-3 h-3 text-muted-foreground flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-muted-foreground leading-snug">
                        {place.formattedAddress}
                      </p>
                    </div>
                    {place.rating && (
                      <div className="flex items-center gap-2 mt-1">
                        <StarRating rating={place.rating.toFixed(1)} />
                        {place.userRatingCount && (
                          <span className="text-xs text-muted-foreground">
                            ({place.userRatingCount} reviews)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-shrink-0"
                    onClick={() => handleConfirm(place)}
                    disabled={createMutation.isPending}
                  >
                    {createMutation.isPending
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <>Select <ArrowRight className="w-3 h-3 ml-1" /></>
                    }
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            onClick={handleManualConfirm}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <>Add "{formValues.name}" manually <ArrowRight className="w-3.5 h-3.5 ml-1" /></>
            }
          </Button>
        )}

        <button
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => { setStep("form"); form.reset(); }}
          data-testid="button-search-again"
        >
          ← Search again with different details
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {!compact && (
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <ChefHat className="w-5 h-5 text-primary" />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">Add your restaurant</p>
            <p className="text-sm text-muted-foreground">We'll find your listing on Google Maps</p>
          </div>
        </div>
      )}

      {searchError && (
        <p className="text-xs text-red-500">{searchError}</p>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSearch)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm">Restaurant Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. Golden Wok"
                    {...field}
                    data-testid="input-restaurant-name"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="address"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm">Address</FormLabel>
                <FormControl>
                  <div className="relative">
                    <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="123 Main St, San Francisco, CA"
                      className="pl-9"
                      {...field}
                      data-testid="input-restaurant-address"
                    />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            className="w-full"
            data-testid="button-search-restaurant"
          >
            OK
          </Button>
        </form>
      </Form>
    </div>
  );
}
