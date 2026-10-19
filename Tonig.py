import dataclasses


@dataclasses.dataclass()
class Phone:
    name: str
    size: int = 64

    def on(self):
        print(f"{self.name} is on")

    def off(self):
        print(f"{self.name} is off")

    def take_photo(self):
        print(f"{self.name} takes photo")


phone1 = Phone("Apple")
