// A screen that leaks English in every way the i18n test looks for. Never
// imported: i18n.test.ts parses it to prove its scanner catches each form.
declare const Text: (props: { children: unknown }) => null;
declare const Input: (props: { placeholder: string }) => null;
declare const Button: (props: { label: string }) => null;
declare function verbatim(value: string): string;

export const options = { title: 'Settings' };

export function Leaky(): unknown {
  return (
    <>
      <Text>Book now</Text>
      <Text>{'Pay now'}</Text>
      <Input placeholder="Your plate" />
      <Button label="Cancel" />
      <Text>{verbatim('Welcome back')}</Text>
    </>
  );
}
