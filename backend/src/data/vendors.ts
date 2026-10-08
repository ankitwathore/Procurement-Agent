/**
 * The five invited vendors (spec 8.2 `vendor`, 17.5). Fictional. Aliases are other ways their names appear, used by
 * the confidentiality guard to stop one vendor's name reaching another.
 */

export interface Vendor {
  vendor_id: string;
  name: string;
  city: string;
  contact_name: string;
  contact_email: string;
  aliases: string[];
}

export const VENDOR_REGISTRY: Vendor[] = [
  { vendor_id: "V1", name: "Shree Ganesh Corrugators", city: "Chakan, Pune", contact_name: "Mr Kale", contact_email: "sales@shreeganesh.example", aliases: ["Shree Ganesh", "SGC"] },
  { vendor_id: "V2", name: "Ahmedabad Packwell Industries", city: "Ahmedabad", contact_name: "Ms Shah", contact_email: "sales@apw.example", aliases: ["Ahmedabad Packwell", "Packwell", "APW"] },
  { vendor_id: "V3", name: "Southern Flute Packaging", city: "Hosur", contact_name: "Mr Senthil", contact_email: "quotes@southernflute.example", aliases: ["Southern Flute", "SFP"] },
  { vendor_id: "V4", name: "Delhi Carton Works", city: "Bahadurgarh", contact_name: "Mr Gupta", contact_email: "dcw.bahadurgarh@example.com", aliases: ["Delhi Carton", "DCW"] },
  { vendor_id: "V5", name: "Jai Bharat Boards", city: "Vapi", contact_name: "Mr Pankaj Shah", contact_email: "pankaj@jaibharatboards.example", aliases: ["Jai Bharat", "JBB"] },
];

export const vendorById = (id: string): Vendor => {
  const v = VENDOR_REGISTRY.find((x) => x.vendor_id === id);
  if (!v) throw new Error(`unknown vendor ${id}`);
  return v;
};
